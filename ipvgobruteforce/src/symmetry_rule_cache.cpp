#include "ipvgobruteforce/symmetry_rule_cache.hpp"

#include "ipvgobruteforce/symmetry.hpp"

#include <array>
#include <atomic>
#include <bit>
#include <chrono>
#include <mutex>
#include <unordered_map>

namespace ipvgobruteforce {
namespace {

constexpr std::size_t shard_count = 64;

std::uint64_t mix(std::uint64_t value) {
  value ^= value >> 30U;
  value *= 0xbf58476d1ce4e5b9ULL;
  value ^= value >> 27U;
  value *= 0x94d049bb133111ebULL;
  return value ^ (value >> 31U);
}

std::uint8_t color_bit(bitburner::go::Stone mover) {
  return mover == bitburner::go::Stone::black ? 0U : 1U;
}

struct ReplayKey {
  PackedBoard board{};
  std::uint8_t coordinate{};
  std::uint8_t mover{};
  friend bool operator==(const ReplayKey&, const ReplayKey&) = default;
};
struct ReplayHash {
  std::size_t operator()(const ReplayKey& key) const noexcept {
    return mix(key.board ^ (static_cast<std::uint64_t>(key.coordinate) << 52U)
      ^ (static_cast<std::uint64_t>(key.mover) << 60U));
  }
};

struct ScoreKey {
  PackedBoard board{};
  std::uint64_t komi{};
  friend bool operator==(const ScoreKey&, const ScoreKey&) = default;
};
struct ScoreHash {
  std::size_t operator()(const ScoreKey& key) const noexcept {
    return mix(key.board ^ mix(key.komi));
  }
};

struct Shard {
  std::mutex mutex;
  std::unordered_map<ReplayKey, PackedMoveReplay, ReplayHash> replay;
  std::unordered_map<ScoreKey, bitburner::go::Score, ScoreHash> score;
};

class Cache {
 public:
  void configure(SymmetryRuleCacheConfig config) {
    std::scoped_lock configuration(configuration_mutex_);
    clear_locked();
    config_ = config;
  }

  void clear() {
    std::scoped_lock configuration(configuration_mutex_);
    clear_locked();
  }

  SymmetryRuleCacheConfig config() const {
    std::scoped_lock configuration(configuration_mutex_);
    return config_;
  }

  SymmetryRuleCacheStats stats() const {
    return {
      .hits = hits_.load(), .misses = misses_.load(),
      .duplicate_computations = duplicates_.load(), .evictions = 0,
      .rejected_admissions = rejected_.load(), .entries = entries_.load(),
      .bytes = bytes_.load(), .contention_nanoseconds = contention_ns_.load(),
    };
  }

  PackedMoveReplay replay(PackedBoard board, bitburner::go::Point point,
    bitburner::go::Stone mover) {
    if (!config_.enabled) return replay_packed_move_uncached(board, point, mover);
    const CanonicalBoard canonical = canonicalize_board(board);
    const bitburner::go::Point canonical_point = transform_point(point, canonical.orientation);
    const ReplayKey key{canonical.board,
      static_cast<std::uint8_t>(canonical_point.x * 5 + canonical_point.y), color_bit(mover)};
    Shard& shard = shards_[ReplayHash{}(key) % shard_count];
    if (const auto found = lookup(shard, shard.replay, key)) {
      PackedMoveReplay result = *found;
      result.board = transform_board(result.board, inverse_symmetry(canonical.orientation));
      return result;
    }
    ++misses_;
    const PackedMoveReplay computed = replay_packed_move_uncached(
      canonical.board, canonical_point, mover);
    const PackedMoveReplay stored = publish(
      shard, shard.replay, key, computed, sizeof(key) + sizeof(computed));
    PackedMoveReplay result = stored;
    result.board = transform_board(result.board, inverse_symmetry(canonical.orientation));
    return result;
  }

  bitburner::go::Score score(PackedBoard board, double komi) {
    if (!config_.enabled) return bitburner::go::score_board(unpack_board(board), komi);
    const CanonicalBoard canonical = canonicalize_board(board);
    const ScoreKey key{canonical.board, std::bit_cast<std::uint64_t>(komi)};
    Shard& shard = shards_[ScoreHash{}(key) % shard_count];
    if (const auto found = lookup(shard, shard.score, key)) return *found;
    ++misses_;
    const auto computed = bitburner::go::score_board(unpack_board(canonical.board), komi);
    return publish(shard, shard.score, key, computed, sizeof(key) + sizeof(computed));
  }

 private:
  template <typename Map, typename Key>
  std::optional<typename Map::mapped_type> lookup(Shard& shard, Map& map, const Key& key) {
    const auto before = std::chrono::steady_clock::now();
    std::lock_guard lock(shard.mutex);
    contention_ns_ += static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::nanoseconds>(
        std::chrono::steady_clock::now() - before).count());
    const auto found = map.find(key);
    if (found == map.end()) return std::nullopt;
    ++hits_;
    return found->second;
  }

  bool reserve(std::size_t bytes) {
    const std::uint64_t entry = entries_.fetch_add(1);
    if (entry >= config_.max_entries) {
      entries_.fetch_sub(1);
      ++rejected_;
      return false;
    }
    const std::uint64_t previous_bytes = bytes_.fetch_add(bytes);
    if (previous_bytes + bytes > config_.max_bytes) {
      bytes_.fetch_sub(bytes);
      entries_.fetch_sub(1);
      ++rejected_;
      return false;
    }
    return true;
  }

  template <typename Map, typename Key>
  typename Map::mapped_type publish(Shard& shard, Map& map, const Key& key,
    const typename Map::mapped_type& value, std::size_t bytes) {
    const auto before = std::chrono::steady_clock::now();
    std::lock_guard lock(shard.mutex);
    contention_ns_ += static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::nanoseconds>(
        std::chrono::steady_clock::now() - before).count());
    if (const auto found = map.find(key); found != map.end()) {
      ++duplicates_;
      ++hits_;
      return found->second;
    }
    if (!reserve(bytes)) return value;
    map.emplace(key, value);
    return value;
  }

  void clear_locked() {
    for (Shard& shard : shards_) {
      std::lock_guard lock(shard.mutex);
      shard.replay.clear();
      shard.score.clear();
    }
    hits_ = 0;
    misses_ = 0;
    duplicates_ = 0;
    rejected_ = 0;
    entries_ = 0;
    bytes_ = 0;
    contention_ns_ = 0;
  }

  mutable std::mutex configuration_mutex_;
  SymmetryRuleCacheConfig config_;
  std::array<Shard, shard_count> shards_;
  std::atomic<std::uint64_t> hits_{};
  std::atomic<std::uint64_t> misses_{};
  std::atomic<std::uint64_t> duplicates_{};
  std::atomic<std::uint64_t> rejected_{};
  std::atomic<std::uint64_t> entries_{};
  std::atomic<std::uint64_t> bytes_{};
  std::atomic<std::uint64_t> contention_ns_{};
};

Cache& cache() {
  static Cache instance;
  return instance;
}

}  // namespace

void configure_symmetry_rule_cache(const SymmetryRuleCacheConfig& config) { cache().configure(config); }
void clear_symmetry_rule_cache() { cache().clear(); }
SymmetryRuleCacheConfig symmetry_rule_cache_config() { return cache().config(); }
SymmetryRuleCacheStats symmetry_rule_cache_stats() { return cache().stats(); }

PackedMoveReplay symmetry_cached_local_replay(PackedBoard board, bitburner::go::Point point,
  bitburner::go::Stone mover) {
  return cache().replay(board, point, mover);
}

bitburner::go::Score symmetry_cached_score(PackedBoard board, double komi) {
  return cache().score(board, komi);
}

}  // namespace ipvgobruteforce

/** Password dictionaries, transcribed from the pinned checkout.
 *
 * Five of the twenty-four server models draw their password from a fixed list
 * through the same one-line `getDictionaryAttackConfig`, which is why they are a
 * single implementation in `models.ts` rather than five. These are those lists.
 *
 * They live here rather than in `models.ts` so the registry stays readable, and
 * in `shared/` rather than `sim/vendor/` because both the game agents and the
 * simulator need them and `game/` may not import simulator code.
 *
 * Source: ../bitburner-src at 3162fd2590e221eadd0c0fbd46151913f7c4c41c
 *   src/DarkNet/models/dictionaryData.ts
 *   src/DarkNet/controllers/ServerGenerator.ts (which config uses which list) */

/** `FreshInstall_1.0` (ModelIds.DefaultPassword). Four entries, so the model is
 *  exhaustible in at most four `authenticate` calls — which, with `ZeroLogon`,
 *  is what makes the second hop into the darknet cheap. */
export const DEFAULT_SETTINGS = ["admin", "password", "0000", "12345"] as const;

/** `Laika4` (ModelIds.DogNames). Also four. */
export const DOG_NAMES = ["fido", "spot", "rover", "max"] as const;

/** `EuroZone Free` (ModelIds.EUCountryDictionary). The EU member states, in
 *  upstream's order — which is the order to try them in, since upstream draws
 *  uniformly and order only matters for how fast we resume a partial ledger. */
export const EU_COUNTRIES = [
  "Austria", "Belgium", "Bulgaria", "Croatia",
  "Republic of Cyprus", "Czech Republic", "Denmark", "Estonia",
  "Finland", "France", "Germany", "Greece",
  "Hungary", "Ireland", "Italy", "Latvia",
  "Lithuania", "Luxembourg", "Malta", "Netherlands",
  "Poland", "Portugal", "Romania", "Slovakia",
  "Slovenia", "Spain", "Sweden",
] as const;

/** `TopPass` (ModelIds.CommonPasswordDictionary). Bounded but long, so an
 *  attempt ledger records how far it got and resumes rather than restarting. */
export const COMMON_PASSWORDS = [
  "123456", "password", "12345678", "qwerty", "123456789", "12345",
  "1234", "111111", "1234567", "dragon", "123123", "baseball",
  "abc123", "football", "monkey", "letmein", "696969", "shadow",
  "master", "666666", "qwertyuiop", "123321", "mustang", "1234567890",
  "michael", "654321", "superman", "1qaz2wsx", "7777777", "121212",
  "0", "qazwsx", "123qwe", "trustno1", "jordan", "jennifer",
  "zxcvbnm", "asdfgh", "hunter", "buster", "soccer", "harley",
  "batman", "andrew", "tigger", "sunshine", "iloveyou", "2000",
  "charlie", "robert", "thomas", "hockey", "ranger", "daniel",
  "starwars", "112233", "george", "computer", "michelle", "jessica",
  "pepper", "1111", "zxcvbn", "555555", "11111111", "131313",
  "freedom", "777777", "pass", "maggie", "159753", "aaaaaa",
  "ginger", "princess", "joshua", "cheese", "amanda", "summer",
  "love", "ashley", "6969", "nicole", "chelsea", "biteme",
  "matthew", "access", "yankees", "987654321", "dallas", "austin",
  "thunder", "taylor", "matrix",
] as const;

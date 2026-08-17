import unittest

import torch

from serve_v9_backend import decode_batch


class ServeV9BackendTest(unittest.TestCase):
    def test_decodes_tactical_bit_planes(self) -> None:
        extent = 5
        tactical = [0] * 8
        tactical[0] = 1 << 3
        tactical[7] = 1 << 24
        inputs, behavior = decode_batch({
            "count": 1,
            "packed": [1 | (2 << 2) | (3 << 4), 0],
            "legal": [1 << 3],
            "state": [0.5, 0.25, 1.0, 0.0],
            "behavior": [float(index) for index in range(3)],
            "tactical": tactical,
        }, extent, 3, 16, torch.device("cpu"))
        self.assertEqual(tuple(inputs.shape), (1, 16, 5, 5))
        self.assertEqual(inputs[0, 0, 0, 0], 1)
        self.assertEqual(inputs[0, 1, 0, 1], 1)
        self.assertEqual(inputs[0, 2, 0, 2], 1)
        self.assertEqual(inputs[0, 3, 0, 3], 1)
        self.assertEqual(inputs[0, 8, 0, 3], 1)
        self.assertEqual(inputs[0, 15, 4, 4], 1)
        self.assertEqual(inputs[0, 4, 2, 2], 0.5)
        self.assertEqual(inputs[0, 5, 2, 2], 0.25)
        self.assertTrue(torch.equal(behavior, torch.tensor([[0.0, 1.0, 2.0]])))

    def test_requires_tactical_payload_for_tactical_model(self) -> None:
        with self.assertRaisesRegex(ValueError, "requires tactical planes"):
            decode_batch({
                "count": 1, "packed": [0, 0], "legal": [0],
                "state": [0, 0, 0, 0], "behavior": [0],
            }, 5, 1, 16, torch.device("cpu"))


if __name__ == "__main__":
    unittest.main()

"""headline.py's text rules (no GPU, no video). Run with the media service's Python:

    ..\\x-requirements\\env\\Scripts\\python.exe -I -m unittest discover -s apps\\xvideos\\media -p "test_*.py"
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import headline  # noqa: E402


def ocr(words):
    """A PaddleOCR result: [(text, score, x)]"""
    return {"rec_texts": [w[0] for w in words], "rec_scores": [w[1] for w in words],
            "rec_boxes": [[w[2], 0, w[2] + 10, 10] for w in words]}


class BarReading(unittest.TestCase):
    def test_words_left_to_right_logo_and_unsure_words_dropped(self):
        res = ocr([("हादसा", 0.9, 300), ("st", 0.9, 5), ("NH-52", 0.95, 100), ("पर", 0.9, 200), ("धुंधला", 0.3, 400), ("LIVE", 0.9, 500)])
        self.assertEqual(headline.bar_reading(res), "NH-52 पर हादसा")

    def test_vote_keeps_the_most_typical_reading(self):
        self.assertEqual(headline.medoid(["जयपुर में हादसा", "जयपर में हादसा", "जयपुर में हादसा", "जयपुर मे हादस"]), "जयपुर में हादसा")


class BarLines(unittest.TestCase):
    def test_groups_merge_and_half_drawn_lines_go(self):
        readings = ["सवार बुजुर्ग", "टक्कर से ई-रिक्शा सवार बुजुर्ग की मौत", "टक्कर से ई-रिक्शा सवार बुजुर्ग की मौत",
                    "NH-52 पर भीषण सड़क हादसा", "NH-52 पर भीषण सडक हादसा", "टक्कर से ई-रिक्शा सवार बुजुर्ग की मौत"]
        groups = [[0], [1, 2], [3], [4], [5]]
        lines = headline.bar_lines(groups, readings)
        self.assertEqual([x["text"] for x in lines], ["टक्कर से ई-रिक्शा सवार बुजुर्ग की मौत", "NH-52 पर भीषण सड़क हादसा"])
        self.assertEqual(lines[0], {"text": "टक्कर से ई-रिक्शा सवार बुजुर्ग की मौत", "secs": 9, "firstS": 4})

    def test_short_latin_bits_are_not_lines(self):
        self.assertEqual(headline.bar_lines([[0], [1]], ["ABC DEF", "हाँ"]), [])


class PanelRows(unittest.TestCase):
    def test_words_on_one_row_join_rows_top_to_bottom(self):
        res = {"rec_texts": ["से", "कोटा", "LIVE", "IAS", "पूनम"], "rec_scores": [0.9] * 5,
               "rec_boxes": [[60, 0, 80, 20], [0, 2, 50, 22], [90, 0, 120, 20], [0, 40, 30, 60], [40, 41, 90, 61]]}
        self.assertEqual(headline.panel_rows(res, 0, 0), ["कोटा से", "IAS पूनम"])


if __name__ == "__main__":
    unittest.main()

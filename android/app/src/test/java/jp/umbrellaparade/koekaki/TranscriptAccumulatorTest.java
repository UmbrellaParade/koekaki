package jp.umbrellaparade.koekaki;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class TranscriptAccumulatorTest {
    @Test
    public void appendsJapaneseSegmentsWithoutAnArtificialSpace() {
        assertEquals("今日はよろしくお願いします", TranscriptAccumulator.append("今日は", "よろしくお願いします"));
    }

    @Test
    public void removesBoundaryOverlap() {
        assertEquals("これは音声入力です", TranscriptAccumulator.append("これは音声", "音声入力です"));
    }

    @Test
    public void ignoresRepeatedSegment() {
        assertEquals("同じ文章", TranscriptAccumulator.append("同じ文章", "同じ文章"));
    }

    @Test
    public void acceptsCumulativeRecognitionResult() {
        assertEquals("前より長い結果です", TranscriptAccumulator.append("前より", "前より長い結果です"));
    }

    @Test
    public void separatesAsciiWords() {
        assertEquals("hello world", TranscriptAccumulator.append("hello", "world"));
    }
}

package jp.umbrellaparade.koekaki;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class TranscriptAccumulatorTest {
    @Test
    public void appendsJapaneseSegmentsWithoutAnArtificialSpace() {
        assertEquals("今日はよろしくお願いします", TranscriptAccumulator.append("今日は", "よろしくお願いします"));
    }

    @Test
    public void removesBoundaryOverlapOfTwoOrMoreCharacters() {
        assertEquals("これは音声入力です", TranscriptAccumulator.append("これは音声", "音声入力です"));
        assertEquals("前半テスト後半", TranscriptAccumulator.append("前半テスト", "テスト後半"));
        assertEquals("これは音声入力です", TranscriptAccumulator.append("これは音声入力", "音声入力です"));
    }

    @Test
    public void doesNotRemoveAnAccidentalOneCharacterJapaneseOverlap() {
        assertEquals("今日はは晴れです", TranscriptAccumulator.append("今日は", "は晴れです"));
    }

    @Test
    public void ignoresRepeatedSegment() {
        assertEquals("同じ文章", TranscriptAccumulator.append("同じ文章", "同じ文章"));
        assertEquals("はい", TranscriptAccumulator.append("はい", "はい"));
    }

    @Test
    public void acceptsCumulativeRecognitionResult() {
        assertEquals("前より長い結果です", TranscriptAccumulator.append("前より", "前より長い結果です"));
    }

    @Test
    public void separatesAsciiWords() {
        assertEquals("hello world", TranscriptAccumulator.append("hello", "world"));
    }

    @Test
    public void appendWithBoundarySeparatesUnrelatedRecognitionSegments() {
        assertEquals("今日は\nよろしくお願いします",
                TranscriptAccumulator.appendWithBoundary("今日は", "よろしくお願いします"));
        assertEquals("今日は\nは晴れです",
                TranscriptAccumulator.appendWithBoundary("今日は", "は晴れです"));
    }

    @Test
    public void appendWithBoundaryStillMergesRealOverlapRepeatsAndCumulativeResults() {
        assertEquals("これは音声入力です",
                TranscriptAccumulator.appendWithBoundary("これは音声", "音声入力です"));
        assertEquals("前半テスト後半",
                TranscriptAccumulator.appendWithBoundary("前半テスト", "テスト後半"));
        assertEquals("これは音声入力です",
                TranscriptAccumulator.appendWithBoundary("これは音声入力", "音声入力です"));
        assertEquals("同じ文章",
                TranscriptAccumulator.appendWithBoundary("同じ文章", "同じ文章"));
        assertEquals("はい",
                TranscriptAccumulator.appendWithBoundary("はい", "はい"));
        assertEquals("前より長い結果です",
                TranscriptAccumulator.appendWithBoundary("前より", "前より長い結果です"));
    }
}

package jp.umbrellaparade.koekaki;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public final class RecognitionResultSelectorTest {
    @Test
    public void fallsBackToPartialWhenFinalResultIsEmpty() {
        assertEquals("ここまで聞き取りました。",
                RecognitionResultSelector.select("  ", " ここまで聞き取りました。 "));
        assertEquals("", RecognitionResultSelector.select(null, null));
    }

    @Test
    public void prefersFinalResultWhenItsTextDiffersFromPartial() {
        assertEquals("今日は晴れです",
                RecognitionResultSelector.select("今日は晴れです", "今日は雨です？"));
    }

    @Test
    public void carriesJapaneseQuestionMarkFromAnOtherwiseIdenticalPartial() {
        assertEquals("どうでしょうか？",
                RecognitionResultSelector.select("どうでしょうか", "どうでしょうか？"));
    }

    @Test
    public void carriesJapaneseAndAsciiTerminalSentencePunctuation() {
        assertEquals("終わりました。",
                RecognitionResultSelector.select("終わりました", "終わりました。"));
        assertEquals("本当ですか？！",
                RecognitionResultSelector.select("本当ですか", "本当ですか？！"));
        assertEquals("Really?!",
                RecognitionResultSelector.select("Really", "Really?!"));
        assertEquals("Done.",
                RecognitionResultSelector.select("Done", "Done."));
    }

    @Test
    public void finalPunctuationWinsWhenBothResultsAlreadyHaveIt() {
        assertEquals("終わりました。",
                RecognitionResultSelector.select("終わりました。", "終わりました！"));
    }

    @Test
    public void doesNotCarryPunctuationUnlessTheBaseMatchesExactly() {
        assertEquals("どうでしょうか",
                RecognitionResultSelector.select("どうでしょうか", "どうなのでしょうか？"));
        assertEquals("本文",
                RecognitionResultSelector.select("本文", "？"));
    }
}

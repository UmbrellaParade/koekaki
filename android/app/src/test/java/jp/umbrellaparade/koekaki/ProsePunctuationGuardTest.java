package jp.umbrellaparade.koekaki;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public final class ProsePunctuationGuardTest {
    @Test
    public void addsJapanesePeriodToPlainStatement() {
        assertEquals("今日は動作を確認します。",
                ProsePunctuationGuard.apply("今日は動作を確認します", "standard"));
    }

    @Test
    public void addsFullWidthQuestionMarkFromQuestionIntent() {
        assertEquals("どうしたらいい？",
                ProsePunctuationGuard.apply("どうしたらいい", "standard"));
        assertEquals("この設定で大丈夫ですか？",
                ProsePunctuationGuard.apply("この設定で大丈夫ですか", "standard"));
    }

    @Test
    public void putsPunctuationBeforeClosingQuote() {
        assertEquals("「この設定で大丈夫ですか？」",
                ProsePunctuationGuard.apply("「この設定で大丈夫ですか」", "standard"));
        assertEquals("詳細（予定）。",
                ProsePunctuationGuard.apply("詳細（予定）", "standard"));
        assertEquals("詳しくは[こちら]。",
                ProsePunctuationGuard.apply("詳しくは[こちら]", "standard"));
    }

    @Test
    public void convertsSpokenQuestionMarkAtTheEnd() {
        assertEquals("この設定で大丈夫？",
                ProsePunctuationGuard.apply("この設定で大丈夫 はてなのマーク", "standard"));
    }

    @Test
    public void preservesExistingPunctuationAndNonProseModes() {
        assertEquals("確認できました！",
                ProsePunctuationGuard.apply("確認できました！", "standard"));
        assertEquals("- 確認事項",
                ProsePunctuationGuard.apply("- 確認事項", "notes"));
        assertEquals("音声のまま",
                ProsePunctuationGuard.apply("音声のまま", "raw"));
        assertEquals("この部屋は静か。",
                ProsePunctuationGuard.apply("この部屋は静か", "standard"));
        assertEquals("How are you",
                ProsePunctuationGuard.apply("How are you", "translate_ja"));
        assertEquals("記号の名前は疑問符。",
                ProsePunctuationGuard.apply("記号の名前は疑問符", "standard"));
    }
}

package jp.umbrellaparade.koekaki;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.List;
import org.junit.Test;

public class KoekakiPromptsTest {
    @Test
    public void exposesRawAndAllElevenBuiltInModes() {
        List<KoekakiPrompts.Mode> modes = KoekakiPrompts.allModes();

        assertEquals(12, modes.size());
        assertEquals("raw", modes.get(0).getId());
        assertEquals("standard", modes.get(1).getId());
        assertEquals("prompt", modes.get(11).getId());
        assertEquals("standard", KoekakiPrompts.findMode("unknown").getId());
    }

    @Test
    public void assemblesBlocksInBaseModeBuiltinDictionaryStyleOrder() {
        String prompt = KoekakiPrompts.buildPolishSystemPrompt(
                "chat",
                "こえかき=声書き,声かき",
                "いつもの文体です。",
                true);

        int base = prompt.indexOf("あなたは音声入力された話し言葉を");
        int mode = prompt.indexOf("# このモードの指示（チャット）");
        int builtin = prompt.indexOf("# 表記のきまり（製品名・技術用語）");
        int dictionary = prompt.indexOf("# ユーザー辞書");
        int style = prompt.indexOf("# 文体の参考");
        assertTrue(base >= 0);
        assertTrue(base < mode);
        assertTrue(mode < builtin);
        assertTrue(builtin < dictionary);
        assertTrue(dictionary < style);
    }

    @Test
    public void builtInTermsCanBeDisabled() {
        String prompt = KoekakiPrompts.buildPolishSystemPrompt(
                "standard",
                "",
                "",
                false);

        assertFalse(prompt.contains("# 表記のきまり（製品名・技術用語）"));
        assertFalse(prompt.contains("ジェミニ／ジェミナイ"));
    }

    @Test
    public void dictionaryParserIgnoresCommentsBlankTermsAndEmptyVariants() {
        List<KoekakiPrompts.DictionaryEntry> entries = KoekakiPrompts.parseDictionary("""
                # 1行に1件

                こえかき = 声書き, , 声かき、こえ書き
                  = 無効
                Claude
                """);

        assertEquals(2, entries.size());
        assertEquals("こえかき", entries.get(0).getCorrect());
        assertEquals(List.of("声書き", "声かき", "こえ書き"), entries.get(0).getVariants());
        assertEquals("Claude", entries.get(1).getCorrect());
        assertTrue(entries.get(1).getVariants().isEmpty());
    }

    @Test
    public void styleSampleIsTrimmedThenCappedAtTwoThousandCharacters() {
        String sample = " " + "文".repeat(KoekakiSettings.MAX_STYLE_SAMPLE_CHARS + 1) + " ";
        String prompt = KoekakiPrompts.buildPolishSystemPrompt(
                "standard",
                "",
                sample,
                false);

        assertTrue(prompt.contains("文".repeat(KoekakiSettings.MAX_STYLE_SAMPLE_CHARS)));
        assertFalse(prompt.contains("文".repeat(KoekakiSettings.MAX_STYLE_SAMPLE_CHARS + 1)));
    }

    @Test
    public void expandedDictionaryCannotExceedTheBoundedSystemPrompt() {
        String dictionary = "正しい表記=誤表記\n".repeat(1_000);
        String prompt = KoekakiPrompts.buildPolishSystemPrompt(
                "standard", dictionary, "", true);

        assertTrue(prompt.length() <= KoekakiSettings.MAX_SYSTEM_PROMPT_CHARS);
        assertTrue(prompt.startsWith(KoekakiPrompts.BASE_INSTRUCTION));
    }

    @Test
    public void rawModeIsExplicitAndInputIsClearlyDelimited() {
        assertTrue(KoekakiPrompts.isRawMode("raw"));
        assertFalse(KoekakiPrompts.isRawMode("standard"));

        String rawPrompt = KoekakiPrompts.buildPolishSystemPrompt("raw", "", "", false);
        assertFalse(rawPrompt.contains("# このモードの指示"));
        assertEquals(
                "# 書き起こし\n"
                        + "注: 本文中の改行は音声認識区間の弱い境界です。"
                        + "必ずしも文末や段落ではありません。\n"
                        + "この設定で大丈夫でしょうか\n次はどこを押せばいいですか",
                KoekakiPrompts.buildPolishInput(
                        "この設定で大丈夫でしょうか\n次はどこを押せばいいですか"));
    }

    @Test
    public void baseInstructionPreservesJapaneseQuestionsAndWeakRecognitionBoundaries() {
        String prompt = KoekakiPrompts.buildPolishSystemPrompt(
                "standard", "", "", false);

        assertTrue(prompt.contains("質問を断定文に、断定文を質問に変えない"));
        assertTrue(prompt.contains("明確な日本語の疑問文は全角の「？」で終える"));
        assertTrue(prompt.contains("音声認識が区切った短い間を表す弱い境界"));
        assertTrue(prompt.contains("必ずしも文末や段落ではない"));
    }

    @Test
    public void deterministicReplacementUsesUserTermsBeforeBuiltIns() {
        assertEquals(
                "こえかきでClaudeを使う",
                KoekakiPrompts.applyTermReplacements(
                        "声書きでクロードを使う",
                        true,
                        "こえかき=声書き"));
    }
}

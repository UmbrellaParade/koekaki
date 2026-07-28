package jp.umbrellaparade.koekaki;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.text.InputType;
import org.junit.Test;

public class SensitiveFieldPolicyTest {
    @Test
    public void blocksTextPasswordFields() {
        int inputType = InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD;
        assertTrue(SensitiveFieldPolicy.isSensitiveInputType(inputType));
    }

    @Test
    public void blocksWebPasswordFields() {
        int inputType = InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD;
        assertTrue(SensitiveFieldPolicy.isSensitiveInputType(inputType));
    }

    @Test
    public void blocksNumericPasswordFields() {
        int inputType = InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_VARIATION_PASSWORD;
        assertTrue(SensitiveFieldPolicy.isSensitiveInputType(inputType));
    }

    @Test
    public void allowsNormalChatFields() {
        int inputType = InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_LONG_MESSAGE;
        assertFalse(SensitiveFieldPolicy.isSensitiveInputType(inputType));
        assertTrue(SensitiveFieldPolicy.isSupportedInputType(inputType));
    }

    @Test
    public void rejectsEditorsWithoutComplexTextInput() {
        assertFalse(SensitiveFieldPolicy.isSupportedInputType(InputType.TYPE_NULL));
    }
}

package jp.umbrellaparade.koekaki;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import java.util.Objects;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Stores one OpenAI API key encrypted by a non-exportable AndroidKeyStore key. */
public final class SecureApiKeyStore {
    private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "koekaki_openai_api_key_aes_v1";
    private static final String PREFERENCES_NAME = "koekaki_secrets";
    private static final String PREFERENCE_VERSION = "version";
    private static final String PREFERENCE_IV = "iv";
    private static final String PREFERENCE_CIPHERTEXT = "cipher";
    private static final String ITEM_NAME = "openai_api_key";
    private static final int STORAGE_VERSION = 1;
    private static final int GCM_TAG_BITS = 128;
    private static final int GCM_IV_BYTES = 12;

    private final Context context;
    private final SharedPreferences preferences;
    private final byte[] associatedData;

    public SecureApiKeyStore(Context context) {
        this.context = Objects.requireNonNull(context, "context").getApplicationContext();
        this.preferences = this.context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE);
        this.associatedData = (this.context.getPackageName()
                + "|" + ITEM_NAME
                + "|" + STORAGE_VERSION).getBytes(StandardCharsets.UTF_8);
    }

    /** Returns whether a complete current-version encrypted envelope is present. */
    public boolean hasSavedKey() {
        return preferences.getInt(PREFERENCE_VERSION, 0) == STORAGE_VERSION
                && !preferences.getString(PREFERENCE_IV, "").isEmpty()
                && !preferences.getString(PREFERENCE_CIPHERTEXT, "").isEmpty();
    }

    public void save(String input)
            throws ApiKeyInputPolicy.ValidationException, SecureStoreException {
        String normalized = ApiKeyInputPolicy.normalize(input);
        byte[] plaintext = normalized.getBytes(StandardCharsets.UTF_8);
        byte[] ciphertext = null;
        byte[] iv = null;
        try {
            SecretKey key = getOrCreateKey();
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key);
            cipher.updateAAD(associatedData);
            ciphertext = cipher.doFinal(plaintext);
            iv = cipher.getIV();
            if (iv == null || iv.length != GCM_IV_BYTES) {
                throw new SecureStoreException(Operation.SAVE);
            }

            boolean committed = preferences.edit()
                    .putInt(PREFERENCE_VERSION, STORAGE_VERSION)
                    .putString(PREFERENCE_IV, Base64.encodeToString(iv, Base64.NO_WRAP))
                    .putString(PREFERENCE_CIPHERTEXT,
                            Base64.encodeToString(ciphertext, Base64.NO_WRAP))
                    .commit();
            if (!committed) {
                throw new SecureStoreException(Operation.SAVE);
            }
        } catch (SecureStoreException exception) {
            throw exception;
        } catch (Exception exception) {
            throw new SecureStoreException(Operation.SAVE);
        } finally {
            Arrays.fill(plaintext, (byte) 0);
            if (ciphertext != null) Arrays.fill(ciphertext, (byte) 0);
            if (iv != null) Arrays.fill(iv, (byte) 0);
        }
    }

    /**
     * Returns the decrypted key, or {@code null} when no key is saved. Any malformed or
     * undecryptable envelope is removed together with its KeyStore alias before this method fails.
     */
    public String load() throws SecureStoreException {
        boolean hasVersion = preferences.contains(PREFERENCE_VERSION);
        boolean hasIv = preferences.contains(PREFERENCE_IV);
        boolean hasCiphertext = preferences.contains(PREFERENCE_CIPHERTEXT);
        if (!hasVersion && !hasIv && !hasCiphertext) return null;

        byte[] plaintext = null;
        byte[] iv = null;
        byte[] ciphertext = null;
        try {
            if (!hasVersion || !hasIv || !hasCiphertext
                    || preferences.getInt(PREFERENCE_VERSION, 0) != STORAGE_VERSION) {
                throw new IllegalStateException("invalid envelope");
            }
            iv = Base64.decode(preferences.getString(PREFERENCE_IV, ""), Base64.NO_WRAP);
            ciphertext = Base64.decode(
                    preferences.getString(PREFERENCE_CIPHERTEXT, ""), Base64.NO_WRAP);
            if (iv.length != GCM_IV_BYTES || ciphertext.length < GCM_TAG_BITS / 8) {
                throw new IllegalStateException("invalid envelope");
            }

            SecretKey key = getExistingKey();
            if (key == null) throw new IllegalStateException("missing key");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(GCM_TAG_BITS, iv));
            cipher.updateAAD(associatedData);
            plaintext = cipher.doFinal(ciphertext);
            String value = new String(plaintext, StandardCharsets.UTF_8);
            return ApiKeyInputPolicy.normalize(value);
        } catch (Exception exception) {
            purgeAfterLoadFailure();
            throw new SecureStoreException(Operation.LOAD);
        } finally {
            if (plaintext != null) Arrays.fill(plaintext, (byte) 0);
            if (iv != null) Arrays.fill(iv, (byte) 0);
            if (ciphertext != null) Arrays.fill(ciphertext, (byte) 0);
        }
    }

    /** Deletes both the encrypted envelope and the key that could decrypt it. */
    public void delete() throws SecureStoreException {
        boolean preferencesDeleted = preferences.edit()
                .remove(PREFERENCE_VERSION)
                .remove(PREFERENCE_IV)
                .remove(PREFERENCE_CIPHERTEXT)
                .commit();
        boolean aliasDeleted = deleteAliasBestEffort();
        if (!preferencesDeleted || !aliasDeleted) {
            throw new SecureStoreException(Operation.DELETE);
        }
    }

    private SecretKey getOrCreateKey() throws Exception {
        SecretKey existing = getExistingKey();
        if (existing != null) return existing;

        KeyGenerator generator = KeyGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE);
        KeyGenParameterSpec specification = new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setKeySize(256)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build();
        generator.init(specification);
        return generator.generateKey();
    }

    private SecretKey getExistingKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(ANDROID_KEYSTORE);
        keyStore.load(null);
        java.security.Key key = keyStore.getKey(KEY_ALIAS, null);
        return key instanceof SecretKey ? (SecretKey) key : null;
    }

    private void purgeAfterLoadFailure() {
        preferences.edit()
                .remove(PREFERENCE_VERSION)
                .remove(PREFERENCE_IV)
                .remove(PREFERENCE_CIPHERTEXT)
                .commit();
        deleteAliasBestEffort();
    }

    private boolean deleteAliasBestEffort() {
        try {
            KeyStore keyStore = KeyStore.getInstance(ANDROID_KEYSTORE);
            keyStore.load(null);
            if (keyStore.containsAlias(KEY_ALIAS)) keyStore.deleteEntry(KEY_ALIAS);
            return true;
        } catch (Exception exception) {
            return false;
        }
    }

    public enum Operation {
        SAVE,
        LOAD,
        DELETE
    }

    /** The exception deliberately excludes cryptographic details and secret material. */
    public static final class SecureStoreException extends Exception {
        private final Operation operation;

        SecureStoreException(Operation operation) {
            super(messageFor(operation));
            this.operation = operation;
        }

        public Operation getOperation() {
            return operation;
        }

        private static String messageFor(Operation operation) {
            if (operation == Operation.SAVE) return "APIキーを安全に保存できませんでした。";
            if (operation == Operation.DELETE) return "保存したAPIキーを削除できませんでした。";
            return "保存したAPIキーを読み込めませんでした。もう一度登録してください。";
        }
    }
}

package com.travelarchive.photos;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

/**
 * The screenshot-description passphrase, kept in the Android Keystore.
 *
 * The phone held the passphrase in memory only, so every launch asked for it
 * again. The desktop has `safeStorage` (DPAPI); this is the phone's equivalent,
 * and `app/src/screenKey.ts` has carried the seam for it since the desktop one
 * was built (`remember`/`recall`/`forget`).
 *
 * **What is stored is not the passphrase.** An AES-256-GCM key is generated
 * inside the Keystore, where the key material never leaves — `getKey()` hands
 * back a handle, not bytes, and the key cannot be exported, not even by this
 * app. What reaches the disk is `base64(iv)|base64(ciphertext)`, which is
 * useless without the key. That is also why `allowBackup` can stay on: a
 * backup carries the ciphertext, and Keystore keys are never backed up, so the
 * copy decrypts nowhere. Nothing here is written to the WebView's
 * `localStorage`, and nothing is logged.
 *
 * `setUserAuthenticationRequired` is deliberately off. Turning it on would
 * make every read require a fingerprint or PIN, and the descriptions are meant
 * to open when the archive does; the archive itself is behind Microsoft's
 * sign-in. The key is still hardware-backed where the device has a TEE.
 *
 * A wrong passphrase never reaches this plugin: `unlockScreenCaptions` decrypts
 * the file first and only calls `rememberScreenKey` when that succeeded, so a
 * typo cannot overwrite a working value.
 */
@CapacitorPlugin(name = "ScreenKey")
public class ScreenKeyPlugin extends Plugin {

    private static final String ALIAS = "travel-archive.screen-key";
    private static final String PREFS = "screen-key";
    private static final String VALUE = "value";
    private static final String SEPARATOR = "|";
    /** 128-bit tags are the Keystore's practical GCM default on every API we ship. */
    private static final int TAG_BITS = 128;

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** The key, created on first use. Throws when the Keystore refuses. */
    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(ALIAS)) {
            return ((KeyStore.SecretKeyEntry) store.getEntry(ALIAS, null)).getSecretKey();
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(
            new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        );
        return generator.generateKey();
    }

    /**
     * Whether remembering is possible on this device.
     *
     * Asked before the "remember" row is offered, the same way the desktop asks
     * `safeStorage` — a Keystore can exist and still refuse on a device that
     * has never had a secure lock screen.
     */
    @PluginMethod
    public void available(PluginCall call) {
        JSObject result = new JSObject();
        try {
            key();
            result.put("available", true);
        } catch (Exception error) {
            result.put("available", false);
        }
        call.resolve(result);
    }

    @PluginMethod
    public void set(PluginCall call) {
        String value = call.getString("value");
        if (value == null || value.isEmpty()) {
            call.reject("no value");
            return;
        }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            byte[] ciphertext = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            String stored =
                Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) +
                SEPARATOR +
                Base64.encodeToString(ciphertext, Base64.NO_WRAP);
            JSObject result = new JSObject();
            boolean ok = prefs().edit().putString(VALUE, stored).commit();
            result.put("ok", ok);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("keystore refused the value: " + error.getClass().getSimpleName());
        }
    }

    /**
     * The passphrase, or null.
     *
     * Null rather than an error covers the two states that are not failures: no
     * value was ever kept, and the value can no longer be read (the Keystore
     * dropped the key, which Android does when the lock screen is reset). The
     * second is cleared on the way out, so the reader is asked once and the
     * next launch is not.
     */
    @PluginMethod
    public void get(PluginCall call) {
        JSObject result = new JSObject();
        String stored = prefs().getString(VALUE, null);
        if (stored == null) {
            result.put("value", JSONObject.NULL);
            call.resolve(result);
            return;
        }
        int split = stored.indexOf(SEPARATOR);
        if (split < 0) {
            forgetNow();
            result.put("value", JSONObject.NULL);
            call.resolve(result);
            return;
        }
        try {
            byte[] iv = Base64.decode(stored.substring(0, split), Base64.NO_WRAP);
            byte[] ciphertext = Base64.decode(stored.substring(split + 1), Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(TAG_BITS, iv));
            String value = new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
            result.put("value", value);
            call.resolve(result);
        } catch (Exception error) {
            forgetNow();
            result.put("value", JSONObject.NULL);
            call.resolve(result);
        }
    }

    /** Let it go: the value and the key that could read it. */
    @PluginMethod
    public void forget(PluginCall call) {
        forgetNow();
        call.resolve();
    }

    private void forgetNow() {
        prefs().edit().remove(VALUE).commit();
        try {
            KeyStore store = KeyStore.getInstance("AndroidKeyStore");
            store.load(null);
            if (store.containsAlias(ALIAS)) store.deleteEntry(ALIAS);
        } catch (Exception ignored) {
            // The value is gone either way; a key with no ciphertext guards nothing.
        }
    }
}

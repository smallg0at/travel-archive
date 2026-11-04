package com.travelarchive.photos;

import android.content.ContentUris;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.provider.MediaStore;
import android.util.Base64;
import androidx.core.content.FileProvider;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;

/**
 * Hands a photo, or a rendered card, to another app.
 *
 * The phone's viewer had a clipboard action planned and it was the wrong shape:
 * almost nothing consumes an image from Android's clipboard, while every chat
 * app accepts a share intent. Two sources, because they cost very different
 * amounts:
 *
 *  - **A photo this phone holds** is shared by its MediaStore `content://` uri
 *    with a read grant. No copy, no re-encode; a 20MB original is handed over
 *    as it sits on disk.
 *  - **Anything else** arrives as bytes — a card is always this — is written
 *    once to the cache and shared through the app's `FileProvider` (declared in
 *    the manifest, cache path already allowed).
 *
 * Deliberately not `@capacitor/share`: that package wraps these same two
 * `Intent` calls and adds a dependency for it.
 */
@CapacitorPlugin(name = "Share")
public class SharePlugin extends Plugin {

    /** Bytes to a cache file, then the chooser. */
    @PluginMethod
    public void share(PluginCall call) {
        String base64 = call.getString("base64");
        if (base64 == null || base64.isEmpty()) {
            call.reject("no bytes");
            return;
        }
        String fileName = call.getString("fileName", "photo.jpg");
        String mime = call.getString("mime", "image/jpeg");
        try {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            File dir = new File(getContext().getCacheDir(), "share");
            if (!dir.exists() && !dir.mkdirs()) throw new IllegalStateException("no cache dir");
            // The name reaches the receiving app's Downloads folder, so it is
            // the archive's own file name, with anything a file system refuses
            // replaced rather than dropped silently.
            File file = new File(dir, safeName(fileName));
            try (FileOutputStream out = new FileOutputStream(file)) {
                out.write(bytes);
            }
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
            send(uri, mime);
            call.resolve();
        } catch (Exception error) {
            call.reject("could not share: " + error.getClass().getSimpleName());
        }
    }

    /** A photo on this phone, by its MediaStore id, without copying it. */
    @PluginMethod
    public void shareDevice(PluginCall call) {
        Long id = mediaId(call.getData().opt("id"));
        if (id == null) {
            call.reject("no id");
            return;
        }
        String mime = call.getString("mime", "image/jpeg");
        try {
            Uri uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id);
            send(uri, mime);
            call.resolve();
        } catch (Exception error) {
            call.reject("could not share: " + error.getClass().getSimpleName());
        }
    }

    private void send(Uri uri, String mime) {
        Intent intent = new Intent(Intent.ACTION_SEND);
        intent.setType(mime);
        intent.putExtra(Intent.EXTRA_STREAM, uri);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        Intent chooser = Intent.createChooser(intent, null);
        chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(chooser);
    }

    /**
     * The id as a number.
     *
     * Not `call.getLong`: Capacitor's Java side only accepts a `Long` there and
     * a number sent from JavaScript arrives as an `Integer` (or `Double`), so
     * `getLong` answers null for every id a caller could actually pass — tried
     * on the device, 42 and 1_000_000_034 both came back as "no id".
     */
    private static Long mediaId(Object raw) {
        if (raw instanceof Number) return ((Number) raw).longValue();
        if (raw == null) return null;
        try {
            return Long.parseLong(raw.toString().trim());
        } catch (NumberFormatException error) {
            return null;
        }
    }

    private static String safeName(String name) {
        String cleaned = name.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
        if (cleaned.isEmpty()) return "photo.jpg";
        return cleaned.length() > 120 ? cleaned.substring(cleaned.length() - 120) : cleaned;
    }
}

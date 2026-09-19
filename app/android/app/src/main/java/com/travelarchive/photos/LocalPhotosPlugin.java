package com.travelarchive.photos;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.ImageDecoder;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.util.Size;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import android.webkit.WebResourceResponse;

/**
 * The photographs this phone already has.
 *
 * Most of the archive was taken on this phone and is still in its camera
 * folder: measured on the owner's, 24,110 of the archive's 31,721 photos, 79GB
 * of 103GB, match byte for byte. Fetching those back out of OneDrive to look at
 * them is absurd — the point photoSource.ts made when it left room for "the
 * device itself" as a third source.
 *
 * This half only lists and serves. Matching is JS (mobile/devicePhotos.ts),
 * on exact file name plus exact byte size, so a photo that was re-encoded on
 * the way into the archive is never mistaken for the one on disk: the same
 * library has 1,898 such names, off by ten times in size.
 *
 * Nothing here leaves the phone, and nothing is written.
 */
@CapacitorPlugin(
    name = "LocalPhotos",
    permissions = {
        @Permission(alias = "mediaImages", strings = { Manifest.permission.READ_MEDIA_IMAGES }),
        @Permission(alias = "storage", strings = { Manifest.permission.READ_EXTERNAL_STORAGE }),
    }
)
public class LocalPhotosPlugin extends Plugin {

    /** Android 13 split the storage permission per media type. */
    private String alias() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU ? "mediaImages" : "storage";
    }

    private boolean granted() {
        return getPermissionState(alias()) == PermissionState.GRANTED;
    }

    private void resolveState(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", granted());
        // Android 14 can grant access to a chosen few photos instead. That is
        // not refusal, and the library query still returns what was chosen.
        result.put("canAsk", getPermissionState(alias()) != PermissionState.DENIED || Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU);
        call.resolve(result);
    }

    @PluginMethod
    public void status(PluginCall call) {
        resolveState(call);
    }

    @PluginMethod
    public void request(PluginCall call) {
        if (granted()) {
            resolveState(call);
            return;
        }
        requestPermissionForAlias(alias(), call, "afterRequest");
    }

    @PermissionCallback
    private void afterRequest(PluginCall call) {
        resolveState(call);
    }

    /**
     * The phone's photo library as "<id>\t<bytes>\t<name>" lines.
     *
     * One string rather than 26,000 objects: the bridge serialises this once,
     * and the JS side wants a Map keyed on name and size anyway.
     */
    @PluginMethod
    public void index(PluginCall call) {
        if (!granted()) {
            call.reject("PERMISSION_DENIED");
            return;
        }
        getBridge().execute(() -> {
            StringBuilder rows = new StringBuilder(1 << 20);
            int count = 0;
            String[] columns = { MediaStore.Images.Media._ID, MediaStore.Images.Media.SIZE, MediaStore.Images.Media.DISPLAY_NAME };
            try (
                Cursor cursor = getContext()
                    .getContentResolver()
                    .query(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, columns, null, null, null)
            ) {
                if (cursor != null) {
                    int idAt = cursor.getColumnIndexOrThrow(MediaStore.Images.Media._ID);
                    int sizeAt = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.SIZE);
                    int nameAt = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DISPLAY_NAME);
                    while (cursor.moveToNext()) {
                        String name = cursor.getString(nameAt);
                        if (name == null) continue;
                        rows.append(cursor.getLong(idAt)).append('\t').append(cursor.getLong(sizeAt)).append('\t').append(name).append('\n');
                        count++;
                    }
                }
            } catch (Exception e) {
                call.reject("QUERY_FAILED", e);
                return;
            }
            JSObject result = new JSObject();
            result.put("rows", rows.toString());
            result.put("count", count);
            call.resolve(result);
        });
    }

    /* --- Serving, for MainActivity's WebViewClient ------------------------ */

    /** Beyond this, a "full resolution" photo is sampled down — a 12MP JPEG is already more than any phone screen. */
    private static final int MAX_FULL_PX = 4096;
    /** Largest thumbnail MediaStore's cache is worth asking for; see serve(). */
    private static final int THUMBNAIL_MAX_PX = 512;

    /** This file's size as MediaStore holds it right now, or null. */
    private static String sizeOf(ContentResolver resolver, Uri item) {
        try (Cursor cursor = resolver.query(item, new String[] { MediaStore.Images.Media.SIZE }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) return Long.toString(cursor.getLong(0));
        } catch (Exception ignored) {
            // Gone, or no longer permitted: treated as a mismatch by the caller.
        }
        return null;
    }

    private static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", new HashMap<>(), new ByteArrayInputStream(new byte[0]));
    }

    private static WebResourceResponse image(String mime, InputStream body, long length) {
        Map<String, String> headers = new HashMap<>();
        // The id identifies one file on this device and its bytes never change,
        // so the WebView may keep it. A deleted photo simply 404s next launch.
        headers.put("Cache-Control", "private, max-age=86400");
        // Without a length, a `fetch()` of one of these never settles — an
        // <img> is fine either way, but the page must be able to ask for bytes
        // (a measurement, a future download) without hanging.
        if (length > 0) headers.put("Content-Length", Long.toString(length));
        return new WebResourceResponse(mime, null, 200, "OK", headers, body);
    }

    private static WebResourceResponse jpeg(Bitmap bitmap, int quality) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(1 << 16);
        bitmap.compress(Bitmap.CompressFormat.JPEG, quality, out);
        bitmap.recycle();
        byte[] bytes = out.toByteArray();
        return image("image/jpeg", new ByteArrayInputStream(bytes), bytes.length);
    }

    /**
     * The original, decoded no larger than `px` on its longest side.
     *
     * The decoder samples while reading, so this costs a fraction of a full
     * decode and never holds the whole picture in memory.
     */
    private static Bitmap sampled(ContentResolver resolver, Uri item, int px) throws Exception {
        ImageDecoder.Source source = ImageDecoder.createSource(resolver, item);
        return ImageDecoder.decodeBitmap(source, (decoder, info, src) -> {
            decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE);
            int w = info.getSize().getWidth();
            int h = info.getSize().getHeight();
            int longest = Math.max(w, h);
            if (longest > px) {
                float k = (float) px / longest;
                decoder.setTargetSize(Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)));
            }
        });
    }

    /**
     * `/_device/thumb/<id>?px=N` and `/_device/full/<id>`, from MediaStore.
     *
     * Thumbnails come from Android's own thumbnail cache, which is why this is
     * worth doing at all: no decode of a 4MB original to draw a 120px square.
     * HEIC — 7,159 files on this phone — is decoded to JPEG here because the
     * WebView cannot display it; everything else is streamed as it sits on
     * disk. Runs on a WebView worker thread, never the UI thread.
     */
    static WebResourceResponse serve(Context context, Uri url) {
        List<String> path = url.getPathSegments(); // _device / thumb|full / id
        if (path.size() != 3) return notFound();
        long id;
        try {
            id = Long.parseLong(path.get(2));
        } catch (NumberFormatException e) {
            return notFound();
        }
        Uri item = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id);
        ContentResolver resolver = context.getContentResolver();
        try {
            // The size the archive recorded, carried on every URL. The library
            // was listed when the app started, and a photo edited in place
            // since then — cropped in the gallery, say — would still match that
            // stale entry. Checked again here, against the file as it is now,
            // so what is served is always the picture the archive describes.
            String expected = url.getQueryParameter("b");
            if (expected != null && !expected.equals(sizeOf(resolver, item))) return notFound();
            if ("thumb".equals(path.get(1))) {
                int px = 512;
                String asked = url.getQueryParameter("px");
                if (asked != null) px = Math.max(96, Math.min(2048, Integer.parseInt(asked)));
                // MediaStore's own thumbnail is the fast path — no decode of a
                // 5MB original to fill a grid square — but it hands back
                // whatever it has cached, measured at 320x240 on this phone
                // however large a size is asked for. Above that it is an
                // upscale, so anything bigger is sampled from the original.
                if (px <= THUMBNAIL_MAX_PX && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    return jpeg(resolver.loadThumbnail(item, new Size(px, px), null), 86);
                }
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return notFound();
                return jpeg(sampled(resolver, item, px), 88);
            }
            if (!"full".equals(path.get(1))) return notFound();

            String mime = resolver.getType(item);
            if (mime != null && (mime.equals("image/jpeg") || mime.equals("image/png") || mime.equals("image/webp") || mime.equals("image/gif"))) {
                // Straight off the disk: the archive's own bytes, unaltered.
                long length = 0;
                try (android.os.ParcelFileDescriptor fd = resolver.openFileDescriptor(item, "r")) {
                    if (fd != null) length = fd.getStatSize();
                } catch (Exception ignored) {
                    // Length is a nicety; the stream below is what matters.
                }
                InputStream body = resolver.openInputStream(item);
                return body == null ? notFound() : image(mime, body, length);
            }
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return notFound();
            return jpeg(sampled(resolver, item, MAX_FULL_PX), 92);
        } catch (Exception e) {
            // A photo deleted since the index was built, a format the decoder
            // refuses, a revoked permission: the page falls back to OneDrive.
            return notFound();
        }
    }
}

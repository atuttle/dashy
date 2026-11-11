package com.wesbos.homehq;

import android.content.Context;
import android.util.AtomicFile;
import android.webkit.WebResourceResponse;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import java.util.regex.*;
import org.json.*;

/** Link-only, read-only Google Photos sync. Files stay in app-private no-backup storage. */
final class PhotoData {
  private static final long HOUR = 3600000, BUDGET = 512L * 1024 * 1024;
  private static final int MAX_PHOTOS = 1000;
  private static final String UA = "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  private static final String ID = "[a-f0-9]{64}";
  private static final Pattern KEYS = Pattern.compile("snAcKc[^}]*?request:\\s*\\[\\s*\"([A-Za-z0-9_-]+)\"\\s*,\\s*null\\s*,\\s*null\\s*,\\s*\"([A-Za-z0-9_-]+)\"", Pattern.DOTALL);
  private final File root;
  private final ExecutorService worker = Executors.newSingleThreadExecutor();
  private volatile Session current;

  PhotoData(Context context) { root = new File(context.getNoBackupFilesDir(), "photos"); }
  void close() { worker.shutdownNow(); }

  static void validateAlbumUrl(String address) throws Exception {
    URI uri = new URI(address);
    if (address.length() > 4096 || !"https".equals(uri.getScheme()) || (uri.getPort() != -1 && uri.getPort() != 443)
        || uri.getRawUserInfo() != null || uri.getRawFragment() != null) throw new IOException("Invalid album link");
    String host = uri.getHost(), path = uri.getPath();
    if ("photos.app.goo.gl".equals(host) && path.matches("/[A-Za-z0-9_-]+/?")) return;
    if ("photos.google.com".equals(host) && path.matches("/share/[A-Za-z0-9_-]+/?")
        && uri.getRawQuery() != null && Pattern.compile("(?:^|&)key=[A-Za-z0-9_-]+(?:&|$)").matcher(uri.getRawQuery()).find()) return;
    throw new IOException("Invalid album link");
  }

  static String imageUrl(String address) throws Exception {
    URI uri = new URI(address);
    if (!"https".equals(uri.getScheme()) || uri.getHost() == null || !uri.getHost().matches("[a-z0-9-]+\\.googleusercontent\\.com")
        || (uri.getPort() != -1 && uri.getPort() != 443) || uri.getRawUserInfo() != null || uri.getRawFragment() != null) throw new IOException("Invalid image URL");
    String path = uri.getRawPath().replaceAll("=[wh]\\d+(?:-[a-z0-9]+)*$", "") + "=w1920-h1920";
    return "https://" + uri.getHost() + path + (uri.getRawQuery() == null ? "" : "?" + uri.getRawQuery());
  }

  private static String hash(byte[] bytes) throws Exception {
    StringBuilder result = new StringBuilder();
    for (byte b : MessageDigest.getInstance("SHA-256").digest(bytes)) result.append(String.format(Locale.ROOT, "%02x", b & 255));
    return result.toString();
  }
  private static String hash(String text) throws Exception { return hash(text.getBytes(StandardCharsets.UTF_8)); }

  private static final class Session {
    final String albumUrl;
    final File folder;
    JSONObject manifest = new JSONObject();
    boolean syncing, error;
    long nextAt;
    Session(String albumUrl, File folder) throws Exception {
      this.albumUrl = albumUrl; this.folder = folder;
      if (!folder.isDirectory() && !folder.mkdirs()) throw new IOException("Cache unavailable");
      manifest.put("version", 1).put("photos", new JSONArray()).put("albumCount", 0).put("syncedAt", JSONObject.NULL).put("capped", false);
      try {
        JSONObject saved = new JSONObject(new String(new AtomicFile(new File(folder, "manifest.json")).readFully(), StandardCharsets.UTF_8));
        JSONArray valid = new JSONArray(), photos = saved.getJSONArray("photos");
        if (saved.getInt("version") != 1) throw new IOException("Unknown manifest");
        for (int i = 0; i < photos.length(); i++) {
          JSONObject p = photos.getJSONObject(i);
          if (p.optString("id").matches(ID)) {
            try (InputStream ignored = new AtomicFile(new File(folder, p.getString("id") + ".img")).openRead()) { /* Recover interrupted writes. */ }
            catch (IOException ignored) { continue; }
          }
          if (p.optString("id").matches(ID) && p.optString("version").matches(ID)
              && new File(folder, p.getString("id") + ".img").length() == p.getLong("bytes") && p.getLong("bytes") > 0
              && p.optString("mime").matches("image/(jpeg|png|webp|gif)")) valid.put(p);
        }
        saved.put("photos", valid); manifest = saved;
      } catch (Exception ignored) { /* Missing/corrupt index is rebuilt at the next successful sync. */ }
    }
    JSONArray photos() throws Exception { return manifest.getJSONArray("photos"); }
  }

  private synchronized Session session(JSONObject settings) throws Exception {
    if (settings == null) { current = null; return null; }
    String url = settings.getString("albumUrl");
    validateAlbumUrl(url);
    if (current == null || !current.albumUrl.equals(url)) current = new Session(url, new File(root, hash(url)));
    return current;
  }

  WebResourceResponse respond(String path, JSONObject settings) throws Exception {
    Session s = session(settings);
    if (path.equals("/api/photos")) return json(snapshot(s));
    String id = path.substring("/api/photos/".length());
    if (s == null || !id.matches(ID)) return missing();
    synchronized (s) {
      for (int i = 0; i < s.photos().length(); i++) {
        JSONObject p = s.photos().getJSONObject(i);
        if (id.equals(p.getString("id"))) {
          try { return new WebResourceResponse(p.getString("mime"), null, 200, "OK", headers("private, max-age=3600"),
              new AtomicFile(new File(s.folder, id + ".img")).openRead()); }
          catch (IOException ignored) { return missing(); }
        }
      }
    }
    return missing();
  }

  private JSONObject snapshot(Session s) throws Exception {
    if (s == null) return new JSONObject().put("configured", false).put("photos", new JSONArray()).put("syncing", false).put("error", false);
    synchronized (s) {
      if (!s.syncing && System.currentTimeMillis() >= s.nextAt) {
        s.syncing = true;
        worker.submit(() -> sync(s));
      }
      JSONArray photos = new JSONArray();
      for (int i = 0; i < s.photos().length(); i++) {
        JSONObject p = s.photos().getJSONObject(i);
        photos.put(new JSONObject().put("id", p.getString("id"))
            .put("src", "/api/photos/" + p.getString("id") + "?v=" + p.getString("version").substring(0, 16))
            .put("o", p.getInt("height") > p.getInt("width") ? "p" : "l")
            .put("capturedAt", p.opt("capturedAt")).put("tag", "google-album").put("place", ""));
      }
      return new JSONObject().put("configured", true).put("syncing", s.syncing).put("error", s.error)
          .put("syncedAt", s.manifest.opt("syncedAt")).put("albumCount", s.manifest.optInt("albumCount"))
          .put("capped", s.manifest.optBoolean("capped")).put("photos", photos);
    }
  }

  private void sync(Session s) {
    boolean failed = false;
    try {
      List<JSONObject> inventory = readAlbum(s.albumUrl);
      Collections.sort(inventory, (a, b) -> Long.compare(b.optLong("capturedAt"), a.optLong("capturedAt")));
      List<JSONObject> selected = inventory.subList(0, Math.min(MAX_PHOTOS, inventory.size()));
      Set<String> wanted = new HashSet<>();
      for (JSONObject p : selected) wanted.add(p.getString("id"));
      long used = 0;
      synchronized (s) {
        JSONArray keep = new JSONArray();
        for (int i = 0; i < s.photos().length(); i++) {
          JSONObject p = s.photos().getJSONObject(i);
          if (wanted.contains(p.getString("id"))) { keep.put(p); used += p.getLong("bytes"); }
        }
        s.manifest.put("photos", keep).put("albumCount", inventory.size()).put("capped", inventory.size() > MAX_PHOTOS);
        save(s);
      }
      File[] files = s.folder.listFiles();
      if (files != null) for (File file : files) {
        String name = file.getName();
        if ((name.matches(ID + "\\.img") && !wanted.contains(name.substring(0, 64))) || name.endsWith(".new")) file.delete();
      }
      for (JSONObject p : selected) {
        if (current != s || Thread.currentThread().isInterrupted()) throw new IOException("Sync stopped");
        JSONObject old = null;
        synchronized (s) {
          for (int i = 0; i < s.photos().length(); i++) if (p.getString("id").equals(s.photos().getJSONObject(i).getString("id"))) old = s.photos().getJSONObject(i);
        }
        if (old != null && old.optString("fingerprint").equals(p.getString("fingerprint"))) continue;
        if (used >= BUDGET) { synchronized (s) { s.manifest.put("capped", true); } break; }
        try {
          byte[] bytes = request(p.getString("url"), null, 10 * 1024 * 1024).bytes;
          String mime = imageType(bytes);
          long total = used - (old == null ? 0 : old.getLong("bytes")) + bytes.length;
          if (total > BUDGET) { synchronized (s) { s.manifest.put("capped", true); } break; }
          atomic(new File(s.folder, p.getString("id") + ".img"), bytes);
          JSONObject item = new JSONObject(p.toString());
          item.remove("url"); item.remove("key");
          item.put("bytes", bytes.length).put("version", hash(bytes)).put("mime", mime);
          synchronized (s) {
            JSONArray updated = new JSONArray();
            for (int i = 0; i < s.photos().length(); i++) if (!item.getString("id").equals(s.photos().getJSONObject(i).getString("id"))) updated.put(s.photos().getJSONObject(i));
            updated.put(item); s.manifest.put("photos", updated); save(s);
          }
          used = total;
        } catch (Exception ignored) { failed = true; }
      }
      synchronized (s) {
        if (!failed) s.manifest.put("syncedAt", System.currentTimeMillis());
        save(s);
      }
    } catch (Exception ignored) { failed = true; }
    finally {
      synchronized (s) { s.syncing = false; s.error = failed; s.nextAt = System.currentTimeMillis() + (failed ? 5 * 60000 : HOUR); }
    }
  }

  private static void save(Session s) throws Exception {
    atomic(new File(s.folder, "manifest.json"), s.manifest.toString().getBytes(StandardCharsets.UTF_8));
  }
  private static void atomic(File path, byte[] bytes) throws Exception {
    AtomicFile target = new AtomicFile(path);
    FileOutputStream out = null;
    try { out = target.startWrite(); out.write(bytes); target.finishWrite(out); }
    catch (Exception e) { if (out != null) target.failWrite(out); throw e; }
  }

  private static final class Reply { byte[] bytes; String redirect; }
  private static Reply request(String address, String form, int limit) throws Exception {
    return request(address, form, limit, null);
  }
  private static Reply request(String address, String form, int limit, String referer) throws Exception {
    HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
    connection.setConnectTimeout(10000); connection.setReadTimeout(15000); connection.setInstanceFollowRedirects(false);
    connection.setRequestProperty("User-Agent", UA); connection.setRequestProperty("Accept-Language", "en-US,en;q=0.9");
    if (referer != null) connection.setRequestProperty("Referer", referer);
    long deadline = System.currentTimeMillis() + 25000;
    try {
      if (form != null) {
        connection.setRequestMethod("POST"); connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded;charset=UTF-8");
        connection.setRequestProperty("Origin", "https://photos.google.com");
        try (OutputStream out = connection.getOutputStream()) { out.write(form.getBytes(StandardCharsets.UTF_8)); }
      }
      int code = connection.getResponseCode();
      Reply reply = new Reply();
      if (form == null && Arrays.asList(301, 302, 303, 307, 308).contains(code)) { reply.redirect = connection.getHeaderField("Location"); return reply; }
      if (code != 200) throw new IOException("Photo provider unavailable");
      try (InputStream in = connection.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
        byte[] buffer = new byte[8192]; int count;
        while ((count = in.read(buffer)) != -1) {
          if (out.size() + count > limit || System.currentTimeMillis() > deadline || Thread.currentThread().isInterrupted()) throw new IOException("Photo response limit");
          out.write(buffer, 0, count);
        }
        reply.bytes = out.toByteArray(); return reply;
      }
    } finally { connection.disconnect(); }
  }

  static String[] parseKeys(String html) throws Exception {
    Matcher keys = KEYS.matcher(html);
    if (!keys.find()) throw new IOException("Shared album unavailable");
    return new String[] { keys.group(1), keys.group(2) };
  }
  static List<JSONObject> readAlbum(String address) throws Exception {
    String[] keys = null;
    for (int i = 0; i < 5; i++) {
      validateAlbumUrl(address);
      Reply reply = request(address, null, 8 * 1024 * 1024);
      if (reply.redirect != null) { address = new URL(new URL(address), reply.redirect).toString(); continue; }
      if (reply.bytes == null) throw new IOException("Album redirect unavailable");
      keys = parseKeys(new String(reply.bytes, StandardCharsets.UTF_8)); break;
    }
    if (keys == null) throw new IOException("Too many redirects");
    LinkedHashMap<String, JSONObject> photos = new LinkedHashMap<>();
    Set<String> tokens = new HashSet<>();
    String next = null;
    int count = 0;
    do {
      if (!tokens.add(next) || tokens.size() > 100) throw new IOException("Repeated album page");
      JSONArray inner = new JSONArray().put(keys[0]).put(next == null ? JSONObject.NULL : next).put(JSONObject.NULL).put(keys[1]);
      JSONArray call = new JSONArray().put("snAcKc").put(inner.toString()).put(JSONObject.NULL).put("generic");
      String envelope = new JSONArray().put(new JSONArray().put(call)).toString();
      String url = "https://photos.google.com/u/0/_/PhotosUi/data/batchexecute?rpcids=snAcKc&source-path=" + URLEncoder.encode("/share/" + keys[0], "UTF-8");
      JSONObject page = parsePage(new String(request(url, "f.req=" + URLEncoder.encode(envelope, "UTF-8"), 8 * 1024 * 1024,
          "https://photos.google.com/share/" + keys[0] + "?key=" + keys[1]).bytes, StandardCharsets.UTF_8));
      count += page.getInt("itemCount");
      if (count > 20000) throw new IOException("Album limit");
      JSONArray items = page.getJSONArray("photos");
      for (int i = 0; i < items.length(); i++) { JSONObject p = items.getJSONObject(i); photos.put(p.getString("key"), p); }
      next = page.isNull("next") ? null : page.getString("next");
    } while (next != null);
    return new ArrayList<>(photos.values());
  }

  static JSONObject parsePage(String text) throws Exception {
    JSONArray payload = null;
    for (String line : text.split("\n")) {
      JSONArray entries;
      try { entries = new JSONArray(line); } catch (JSONException ignored) { continue; }
      for (int i = 0; i < entries.length(); i++) {
        JSONArray entry = entries.optJSONArray(i);
        if (entry != null && "wrb.fr".equals(entry.optString(0)) && "snAcKc".equals(entry.optString(1)) && entry.opt(2) instanceof String) {
          payload = new JSONArray(entry.getString(2)); break;
        }
      }
      if (payload != null) break;
    }
    if (payload == null || payload.optJSONArray(1) == null || !(payload.isNull(2) || payload.opt(2) instanceof String)) throw new IOException("Album format changed");
    JSONArray rawItems = payload.getJSONArray(1), photos = new JSONArray();
    for (int i = 0; i < rawItems.length(); i++) {
      Object rawValue = rawItems.get(i);
      if (marker(rawValue, "76647426", 0) && !marker(rawValue, "146008172", 0)) continue;
      if (!(rawValue instanceof JSONArray)) throw new IOException("Album item changed");
      JSONArray raw = (JSONArray) rawValue, visual = raw.optJSONArray(1);
      if (!(raw.opt(0) instanceof String) || !raw.getString(0).matches("[A-Za-z0-9_-]{1,1024}") || visual == null
          || !(visual.opt(1) instanceof Number) || !(visual.opt(2) instanceof Number) || visual.getInt(1) <= 0 || visual.getInt(2) <= 0) throw new IOException("Album item changed");
      String url = imageUrl(visual.getString(0));
      Object captured = raw.opt(2);
      if (!(captured instanceof Number) || ((Number) captured).longValue() < -2208988800000L || ((Number) captured).longValue() > 4102444800000L) captured = JSONObject.NULL;
      photos.put(new JSONObject().put("key", raw.getString(0)).put("id", hash(raw.getString(0))).put("url", url).put("fingerprint", hash(url))
          .put("width", visual.getInt(1)).put("height", visual.getInt(2)).put("capturedAt", captured));
    }
    Object next = payload.opt(2);
    return new JSONObject().put("photos", photos).put("next", next instanceof String && !((String) next).isEmpty() ? next : JSONObject.NULL).put("itemCount", rawItems.length());
  }

  private static boolean marker(Object node, String marker, int depth) throws Exception {
    if (depth > 8) return false;
    if (node instanceof JSONObject) {
      JSONObject object = (JSONObject) node;
      if (object.has(marker)) return true;
      Iterator<String> keys = object.keys();
      while (keys.hasNext()) if (marker(object.get(keys.next()), marker, depth + 1)) return true;
    } else if (node instanceof JSONArray) {
      JSONArray array = (JSONArray) node;
      for (int i = 0; i < array.length(); i++) if (marker(array.get(i), marker, depth + 1)) return true;
    }
    return false;
  }

  static String imageType(byte[] b) throws Exception {
    if (b.length >= 3 && (b[0] & 255) == 255 && (b[1] & 255) == 216 && (b[2] & 255) == 255) return "image/jpeg";
    if (b.length >= 8 && Arrays.equals(Arrays.copyOf(b, 8), new byte[] {(byte)137,80,78,71,13,10,26,10})) return "image/png";
    String first = new String(b, 0, Math.min(12, b.length), StandardCharsets.US_ASCII);
    if (first.startsWith("RIFF") && first.endsWith("WEBP")) return "image/webp";
    if (first.startsWith("GIF87a") || first.startsWith("GIF89a")) return "image/gif";
    throw new IOException("Unexpected image format");
  }
  private static Map<String, String> headers(String cache) {
    Map<String, String> headers = new HashMap<>(); headers.put("Cache-Control", cache); headers.put("X-Content-Type-Options", "nosniff"); return headers;
  }
  private static WebResourceResponse json(JSONObject value) {
    return new WebResourceResponse("application/json", "utf-8", 200, "OK", headers("no-store"), new ByteArrayInputStream(value.toString().getBytes(StandardCharsets.UTF_8)));
  }
  private static WebResourceResponse missing() {
    return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers("no-store"), null);
  }
}

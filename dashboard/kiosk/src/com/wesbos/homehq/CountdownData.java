package com.wesbos.homehq;

import android.content.Context;
import android.util.AtomicFile;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import org.json.JSONObject;

/** A separate read-only feed, checked at 06:00, 12:00, and 17:00 Eastern. */
class CountdownData {
  private static final ZoneId ZONE = ZoneId.of("America/New_York");
  private static final long RETRY = 5 * 60 * 1000;
  private final File directory;
  private String currentUrl;
  private AtomicFile cacheFile;
  private JSONObject saved;
  private long attemptedAt;
  private boolean error;

  CountdownData(Context context) { directory = new File(context.getNoBackupFilesDir(), "countdowns"); }
  // Host probes run the same scheduling/fetch logic without Android storage.
  CountdownData() { directory = null; }
  long now() { return System.currentTimeMillis(); }
  String download(String url) throws Exception { return FrameData.download(url, null); }

  static long lastRefreshAt(long now) { return slot(now, false); }
  static long nextRefreshAt(long now) { return slot(now, true); }
  private static long slot(long now, boolean future) {
    LocalDate date = Instant.ofEpochMilli(now).atZone(ZONE).toLocalDate();
    long selected = future ? Long.MAX_VALUE : Long.MIN_VALUE;
    for (int offset = -1; offset <= 1; offset++) for (int hour : new int[] { 6, 12, 17 }) {
      long time = date.plusDays(offset).atTime(hour, 0).atZone(ZONE).toInstant().toEpochMilli();
      if (future && time > now) selected = Math.min(selected, time);
      if (!future && time <= now) selected = Math.max(selected, time);
    }
    return selected;
  }

  JSONObject snapshot(JSONObject settings) throws Exception { return snapshot(settings, false); }

  synchronized JSONObject snapshot(JSONObject settings, boolean force) throws Exception {
    String url = settings == null ? null : settings.optString("url", null);
    if (url == null || url.isEmpty()) return new JSONObject().put("configured", false).put("error", false).put("nextRefreshAt", nextRefreshAt(now()));
    if (!url.equals(currentUrl)) {
      currentUrl = url; saved = null; attemptedAt = 0; error = false; cacheFile = null;
      if (directory != null) {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(url.getBytes(StandardCharsets.UTF_8));
        StringBuilder name = new StringBuilder(); for (byte value : digest) name.append(String.format("%02x", value & 255));
        cacheFile = new AtomicFile(new File(directory, name + ".json"));
        try {
          byte[] bytes = cacheFile.readFully();
          if (bytes.length <= 5 * 1024 * 1024) {
            JSONObject data = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
            if (data.getLong("fetchedAt") > 0 && data.getLong("fetchedAt") <= now()) {
              saved = new JSONObject().put("fetchedAt", data.getLong("fetchedAt")).put("ics", FrameData.sanitizeCalendar(data.getString("ics"), url));
            }
          }
        } catch (Exception ignored) { /* Initial run or interrupted cache; fetch normally. */ }
      }
    }
    long time = now();
    long retryAt = attemptedAt == 0 ? 0 : Math.min(attemptedAt + RETRY, nextRefreshAt(attemptedAt));
    if (force || ((saved == null || saved.getLong("fetchedAt") < lastRefreshAt(time)) && (!error || time >= retryAt))) {
      attemptedAt = time;
      try {
        String ics = FrameData.sanitizeCalendar(download(url), url);
        saved = new JSONObject().put("ics", ics).put("fetchedAt", now()); error = false;
        if (cacheFile != null) {
          FileOutputStream output = null;
          try {
            directory.mkdirs(); directory.setReadable(false, false); directory.setWritable(false, false); directory.setExecutable(false, false);
            directory.setReadable(true, true); directory.setWritable(true, true); directory.setExecutable(true, true);
            output = cacheFile.startWrite(); output.write(saved.toString().getBytes(StandardCharsets.UTF_8)); cacheFile.finishWrite(output);
            File file = cacheFile.getBaseFile(); file.setReadable(false, false); file.setWritable(false, false); file.setReadable(true, true); file.setWritable(true, true);
          } catch (Exception ignored) { if (output != null) cacheFile.failWrite(output); }
        }
      } catch (Exception ignored) { error = true; }
    }
    JSONObject result = new JSONObject().put("configured", true).put("error", error).put("stale", error && saved != null)
        .put("nextRefreshAt", error ? Math.min(attemptedAt + RETRY, nextRefreshAt(attemptedAt)) : nextRefreshAt(now()));
    if (saved != null) result.put("ics", saved.getString("ics")).put("fetchedAt", saved.getLong("fetchedAt"));
    return result;
  }
}

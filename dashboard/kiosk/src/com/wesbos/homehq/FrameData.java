package com.wesbos.homehq;

import android.content.Context;
import android.net.Uri;
import android.webkit.WebResourceResponse;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import org.json.JSONArray;
import org.json.JSONObject;

/** Fetches private feeds in native code. Neither credentials nor feed URLs enter the WebView. */
final class FrameData {
  private static final long REFRESH_MS = 15 * 60 * 1000;
  private static final int MAX_BYTES = 4 * 1024 * 1024;
  private final Context context;
  private final ExecutorService pool = Executors.newFixedThreadPool(5);
  private final Map<String, FeedCache> feeds = new HashMap<>();
  private final SkydivingData skydiving = new SkydivingData();
  private final TravelData travel = new TravelData();
  private final CountdownData countdowns;
  private final PhotoData photos;
  private JSONObject weather;
  private long weatherAttempt;
  private boolean weatherError;

  FrameData(Context context) { this.context = context.getApplicationContext(); this.photos = new PhotoData(this.context); this.countdowns = new CountdownData(this.context); }
  void close() { pool.shutdownNow(); skydiving.close(); photos.close(); }

  WebResourceResponse respond(Uri uri, String method, boolean trusted) {
    if (!trusted) return response(403, "Forbidden", "{}");
    if (!"GET".equals(method) && !("POST".equals(method) && ("/api/countdowns".equals(uri.getPath()) || "/api/calendars".equals(uri.getPath())))) return response(405, "Method Not Allowed", "{}");
    try {
      JSONObject config = ConfigStore.load(context);
      if (config == null) throw new IOException("Unconfigured");
      String path = uri.getPath();
      if (path.equals("/api/photos") || path.startsWith("/api/photos/")) return photos.respond(path, config.optJSONObject("photos"));
      JSONObject value;
      if (path.equals("/api/calendars")) value = calendars(config.getJSONArray("calendars"), "POST".equals(method));
      else if (path.equals("/api/countdowns")) value = countdowns.snapshot(config.optJSONObject("countdowns"), "POST".equals(method));
      else if (path.equals("/api/travel")) value = travel.snapshot(config.optJSONObject("travel"), uri.getQueryParameter("destination"), uri.getQueryParameter("eventStart"));
      else if (path.equals("/api/skydiving")) value = skydiving.snapshot(config.has("weather") ? config.getJSONObject("weather").optString("apiKey", null) : null);
      else value = forecast(config.getJSONObject("weather"));
      return response(200, "OK", value.toString());
    } catch (Exception ignored) {
      // Network and JSON errors may contain private URLs or keys. Never log their details.
      return response(503, "Service Unavailable", "{\"error\":\"Data unavailable. Retrying shortly.\"}");
    }
  }

  private static WebResourceResponse response(int status, String reason, String body) {
    Map<String, String> headers = new HashMap<>();
    headers.put("Cache-Control", "no-store");
    headers.put("X-Content-Type-Options", "nosniff");
    // No CORS: only the bundled dashboard's origin can read these responses.
    return new WebResourceResponse("application/json", "utf-8", status, reason, headers,
        new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8)));
  }

  private JSONObject calendars(JSONArray configured, boolean force) throws Exception {
    List<Callable<JSONObject>> tasks = new ArrayList<>();
    for (int i = 0; i < configured.length(); i++) {
      final JSONObject feed = configured.getJSONObject(i);
      tasks.add(() -> readFeed(feed, force));
    }
    JSONArray results = new JSONArray();
    for (Future<JSONObject> result : pool.invokeAll(tasks)) results.put(result.get());
    return new JSONObject().put("feeds", results);
  }

  private JSONObject readFeed(JSONObject feed, boolean force) throws Exception {
    String id = feed.getString("id");
    FeedCache saved;
    synchronized (feeds) {
      saved = feeds.get(id);
      if (saved == null) { saved = new FeedCache(); feeds.put(id, saved); }
    }
    synchronized (saved) {
      String url = feed.getString("url");
      // An imported replacement URL must not reuse the old feed's cache.
      if (!url.equals(saved.url)) { saved.url = url; saved.ics = null; saved.attempt = 0; }
      long now = System.currentTimeMillis();
      if (force || now - saved.attempt >= (saved.error ? 60000 : REFRESH_MS)) {
        saved.attempt = now;
        try {
          saved.ics = sanitizeCalendar(download(url, null), url);
          saved.fetchedAt = System.currentTimeMillis();
          saved.error = false;
        } catch (Exception ignored) {
          saved.error = true;
          if (now - saved.fetchedAt >= 86400000) saved.ics = null;
        }
      }
      JSONObject result = new JSONObject().put("id", id).put("calendar", feed.getString("calendar"))
          .put("error", saved.error).put("stale", saved.error && saved.ics != null);
      if (saved.ics != null) result.put("ics", saved.ics).put("fetchedAt", saved.fetchedAt);
      return result;
    }
  }

  private static final class FeedCache {
    String url, ics;
    long attempt, fetchedAt;
    boolean error;
  }

  static String download(String address, String apiKey) throws Exception {
    URL url = new URL(address);
    if (!"https".equals(url.getProtocol())) throw new IOException("HTTPS required");
    HttpURLConnection connection = (HttpURLConnection) url.openConnection();
    connection.setConnectTimeout(10000);
    connection.setReadTimeout(12000);
    connection.setInstanceFollowRedirects(false);
    if (apiKey != null) connection.setRequestProperty("apikey", apiKey);
    try {
      if (connection.getResponseCode() != 200) throw new IOException("Provider unavailable");
      try (InputStream input = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
        byte[] buffer = new byte[8192];
        int count;
        long deadline = System.currentTimeMillis() + 15000;
        while ((count = input.read(buffer)) != -1) {
          if (output.size() + count > MAX_BYTES || System.currentTimeMillis() > deadline) throw new IOException("Response limit");
          output.write(buffer, 0, count);
        }
        return new String(output.toByteArray(), StandardCharsets.UTF_8);
      }
    } finally { connection.disconnect(); }
  }

  private static final Set<String> EVENT_FIELDS = new HashSet<>(Arrays.asList(
      "UID", "DTSTART", "DTEND", "DURATION", "RRULE", "RDATE", "EXDATE", "RECURRENCE-ID",
      "STATUS", "SUMMARY", "LOCATION", "DESCRIPTION", "SEQUENCE", "LAST-MODIFIED"));
  private static final Set<String> ZONE_FIELDS = new HashSet<>(Arrays.asList(
      "TZID", "TZOFFSETFROM", "TZOFFSETTO", "TZNAME", "DTSTART", "RRULE", "RDATE"));

  static String sanitizeCalendar(String text, String secretUrl) throws IOException {
    // RFC 5545 folding: a leading space/tab continues the previous content line.
    String unfolded = text.replaceAll("\\r?\\n[ \\t]", "");
    StringBuilder safe = new StringBuilder();
    List<String> stack = new ArrayList<>();
    boolean calendar = false;
    for (String line : unfolded.split("\\r?\\n")) {
      int colon = line.indexOf(':');
      if (colon < 0) continue;
      String property = line.substring(0, colon).split(";", 2)[0].toUpperCase(java.util.Locale.ROOT);
      String value = line.substring(colon + 1);
      if (property.equals("BEGIN")) {
        stack.add(value.toUpperCase(java.util.Locale.ROOT));
        if (allowedComponent(stack)) {
          safe.append("BEGIN:").append(stack.get(stack.size() - 1)).append("\r\n");
          if (stack.size() == 1) { calendar = true; safe.append("VERSION:2.0\r\n"); }
        }
      } else if (property.equals("END")) {
        if (stack.isEmpty() || !stack.get(stack.size() - 1).equalsIgnoreCase(value)) throw new IOException("Invalid calendar");
        if (allowedComponent(stack)) safe.append("END:").append(stack.get(stack.size() - 1)).append("\r\n");
        stack.remove(stack.size() - 1);
      } else if (allowedComponent(stack) && stack.size() > 1) {
        Set<String> fields = stack.get(1).equals("VEVENT") ? EVENT_FIELDS : ZONE_FIELDS;
        if (fields.contains(property)) safe.append(line).append("\r\n");
      }
    }
    if (!calendar || !stack.isEmpty()) throw new IOException("Invalid calendar");
    return safe.toString().replace(secretUrl, "[redacted]");
  }

  private static boolean allowedComponent(List<String> stack) {
    if (stack.isEmpty() || !stack.get(0).equals("VCALENDAR")) return false;
    if (stack.size() == 1) return true;
    if (stack.size() == 2) return stack.get(1).equals("VEVENT") || stack.get(1).equals("VTIMEZONE");
    return stack.size() == 3 && stack.get(1).equals("VTIMEZONE")
        && (stack.get(2).equals("STANDARD") || stack.get(2).equals("DAYLIGHT"));
  }

  private synchronized JSONObject forecast(JSONObject settings) throws Exception {
    long now = System.currentTimeMillis();
    if (now - weatherAttempt >= (weatherError ? 60000 : REFRESH_MS)) {
      weatherAttempt = now;
      try {
        String url = "https://api.pirateweather.net/forecast/dashy/" + settings.getDouble("latitude")
            + "," + settings.getDouble("longitude") + "?units=us&exclude=minutely,alerts";
        JSONObject raw = new JSONObject(download(url, settings.getString("apiKey")));
        JSONObject current = raw.getJSONObject("currently");
        JSONObject hourly = raw.getJSONObject("hourly");
        JSONObject today = raw.getJSONObject("daily").getJSONArray("data").getJSONObject(0);
        JSONArray hours = new JSONArray(), data = hourly.getJSONArray("data");
        if (data.length() == 0) throw new IOException("Incomplete weather");
        for (int i = 0; i < Math.min(48, data.length()); i++) hours.put(point(data.getJSONObject(i)));
        weather = new JSONObject().put("source", "Pirate Weather").put("fetchedAt", System.currentTimeMillis())
            .put("location", new JSONObject().put("name", "New York, NY").put("latitude", settings.getDouble("latitude"))
                .put("longitude", settings.getDouble("longitude")))
            .put("units", new JSONObject().put("temperature", "F").put("wind", "mph"))
            .put("current", point(current).put("summary", current.optString("summary", "Current conditions"))
                .put("feelsLike", current.opt("apparentTemperature")).put("windSpeed", current.opt("windSpeed"))
                .put("humidity", current.opt("humidity")))
            .put("summary", hourly.optString("summary", current.optString("summary")))
            .put("high", today.has("temperatureMax") ? today.getDouble("temperatureMax") : today.getDouble("temperatureHigh"))
            .put("low", today.has("temperatureMin") ? today.getDouble("temperatureMin") : today.getDouble("temperatureLow"))
            .put("hourly", hours);
        weatherError = false;
      } catch (Exception ignored) { weatherError = true; }
    }
    if (weather == null || now - weather.getLong("fetchedAt") >= 2 * 60 * 60 * 1000) throw new IOException("Unavailable");
    return new JSONObject(weather.toString()).put("stale", weatherError);
  }

  private static JSONObject point(JSONObject raw) throws Exception {
    return new JSONObject().put("time", raw.getDouble("time") * 1000).put("temperature", raw.getDouble("temperature"))
        .put("icon", raw.optString("icon", "cloudy")).put("precipProbability", raw.opt("precipProbability"));
  }
}

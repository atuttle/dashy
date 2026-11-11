package com.wesbos.homehq;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;

/** Private TomTom client. Credentials and geocoded positions never enter WebView responses. */
class TravelData {
  private static final long MINUTE = 60000, RETRY = 5 * MINUTE, DAY = 86400000;
  private static final String BASE = "https://api.tomtom.com/maps/orbis/";
  private static final Pattern ADDRESS = Pattern.compile("\\b\\d+[A-Za-z]?(?:-\\d+)?\\s+(?:[A-Za-z0-9.'’\\-]+\\s+){1,8}(?:street|st|road|rd|avenue|ave|boulevard|blvd|drive|dr|lane|ln|court|ct|circle|cir|way|pike|highway|hwy|parkway|pkwy|terrace|ter|trail|trl|place|pl)\\b\\.?", Pattern.CASE_INSENSITIVE);
  private static final Pattern VIRTUAL = Pattern.compile("https?://|\\b(?:zoom|teams|meet\\.google|p\\.?\\s*o\\.?\\s+box)\\b", Pattern.CASE_INSENSITIVE);
  private final Map<String, GeoCache> geocodes = new LinkedHashMap<>();
  private final Map<String, RouteCache> routes = new LinkedHashMap<>();
  private String identity = "";

  static String addressQuery(String value) {
    if (value == null || value.length() > 1024 || VIRTUAL.matcher(value).find()) return null;
    String text = value.replaceAll("\\s+", " ").trim();
    Matcher match = ADDRESS.matcher(text);
    return match.find() ? text.substring(match.start()) : null;
  }

  static double bufferSeconds(double duration) { return 300 + Math.min(900, duration / 6); }

  synchronized JSONObject snapshot(JSONObject settings, String destination, String startText) throws Exception {
    if (settings == null || !"tomtom".equals(settings.optString("provider"))) return new JSONObject().put("status", "unconfigured");
    String home = addressQuery(settings.optString("homeAddress", null));
    if (home == null) return new JSONObject().put("status", "unconfigured");
    if (!identity.equals(settings.toString())) {
      identity = settings.toString(); geocodes.clear(); routes.clear();
    }
    long now = System.currentTimeMillis(), start;
    try { start = Long.parseLong(startText); }
    catch (Exception ignored) { return new JSONObject().put("status", "skipped"); }
    String address = addressQuery(destination);
    if (address == null || start <= now || start > now + DAY) return new JSONObject().put("status", "skipped");
    String key = address + "\n" + start;
    RouteCache previous = routes.get(key);
    if (previous != null) {
      long due = previous.nextCheck;
      if ("ok".equals(previous.value.optString("status"))) {
        double duration = previous.value.getDouble("driveSeconds");
        double leaveAt = start - (duration + bufferSeconds(duration)) * 1000;
        due = Math.min(due, previous.value.getLong("fetchedAt") + (leaveAt - now <= 2 * 60 * MINUTE ? RETRY : 30 * MINUTE));
      }
      if (now < due) return new JSONObject(previous.value.toString()).put("nextCheckAt", due);
    }
    JSONObject result;
    long nextCheck;
    try {
      String apiKey = settings.getString("apiKey");
      JSONArray origin = geocode(home, null, apiKey), end = geocode(address, origin, apiKey);
      long arrival = start - Math.round((previous == null ? 0 : previous.value.optDouble("bufferSeconds", 0)) * 1000);
      JSONObject body = new JSONObject().put("routePlanningLocations", new JSONObject()
          .put("origin", new JSONObject().put("type", "Point").put("coordinates", origin))
          .put("destination", new JSONObject().put("type", "Point").put("coordinates", end)))
          .put("travelMode", "car").put("routeType", "fast").put("traffic", "live");
      if (arrival > System.currentTimeMillis()) body.put("arrivalDateTime", Instant.ofEpochMilli(arrival).toString());
      else body.put("departureDateTime", "now");
      JSONObject raw = request(BASE + "routing/routes/calculate", "3", "routes.summary", body, apiKey);
      double duration = raw.getJSONArray("routes").getJSONObject(0).getJSONObject("summary").getDouble("travelDurationInSeconds");
      if (!Double.isFinite(duration) || duration < 0 || duration > 86400) throw new IOException("Invalid route");
      long fetchedAt = System.currentTimeMillis();
      double leaveAt = start - (duration + bufferSeconds(duration)) * 1000;
      nextCheck = fetchedAt + (leaveAt - fetchedAt <= 2 * 60 * MINUTE ? RETRY : 30 * MINUTE);
      result = new JSONObject().put("status", "ok").put("source", "TomTom").put("driveSeconds", duration)
          .put("bufferSeconds", bufferSeconds(duration)).put("fetchedAt", fetchedAt).put("nextCheckAt", nextCheck);
    } catch (Exception ignored) {
      nextCheck = System.currentTimeMillis() + RETRY;
      result = new JSONObject().put("status", "unavailable").put("nextCheckAt", nextCheck);
    }
    if (routes.size() >= 64) routes.remove(routes.keySet().iterator().next());
    routes.put(key, new RouteCache(result, nextCheck));
    return result;
  }

  private JSONArray geocode(String address, JSONArray origin, String apiKey) throws Exception {
    GeoCache saved = geocodes.get(address);
    if (saved != null && System.currentTimeMillis() < saved.expires) {
      if (saved.point == null) throw new IOException("Address unavailable");
      return saved.point;
    }
    try {
      String url = BASE + "places/geocode?query=" + URLEncoder.encode(address, "UTF-8")
          + "&types=address&maxResults=2&countryCodesIso2=US";
      if (origin != null) url += "&position=" + origin.getDouble(0) + "," + origin.getDouble(1);
      JSONArray results = request(url, "2", "results(type,position,address)", null, apiKey).getJSONArray("results");
      JSONArray point = null;
      String matchedIdentity = null;
      String house = address.split("\\s+", 2)[0];
      Matcher postalMatch = Pattern.compile("\\b(\\d{5})(?:-\\d{4})?(?:,?\\s*(?:USA|United States))?$", Pattern.CASE_INSENSITIVE).matcher(address);
      String postal = postalMatch.find() ? postalMatch.group(1) : null;
      for (int i = 0; i < results.length(); i++) {
        JSONObject item = results.getJSONObject(i), details = item.optJSONObject("address"), position = item.optJSONObject("position");
        if (!"address".equals(item.optString("type")) || details == null || position == null
            || !house.equalsIgnoreCase(details.optString("houseNumber")) || details.optString("street").isEmpty()
            || (postal != null && !details.optString("postalCode").startsWith(postal))
            || !"Point".equals(position.optString("type"))) continue;
        JSONArray candidate = position.optJSONArray("coordinates");
        if (candidate == null || candidate.length() != 2) continue;
        double lon = candidate.getDouble(0), lat = candidate.getDouble(1);
        if (!Double.isFinite(lon) || !Double.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) continue;
        StringBuilder signature = new StringBuilder();
        for (String field : new String[] { "houseNumber", "street", "municipality", "countrySubdivision", "postalCode" }) signature.append(details.optString(field).toLowerCase(java.util.Locale.ROOT)).append('|');
        if (point == null) { point = candidate; matchedIdentity = signature.toString(); }
        else if (!matchedIdentity.equals(signature.toString()) && Math.hypot(lon - point.getDouble(0), lat - point.getDouble(1)) > 0.002) throw new IOException("Ambiguous address");
      }
      if (point == null) throw new IOException("Address unavailable");
      if (geocodes.size() >= 256) geocodes.remove(geocodes.keySet().iterator().next());
      geocodes.put(address, new GeoCache(point, System.currentTimeMillis() + DAY));
      return point;
    } catch (Exception ignored) {
      geocodes.put(address, new GeoCache(null, System.currentTimeMillis() + RETRY));
      throw new IOException("Address unavailable");
    }
  }

  JSONObject request(String address, String version, String attributes, JSONObject body, String key) throws Exception {
    HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
    connection.setInstanceFollowRedirects(false);
    connection.setConnectTimeout(12000); connection.setReadTimeout(12000);
    connection.setRequestProperty("TomTom-Api-Key", key);
    connection.setRequestProperty("TomTom-Api-Version", version);
    connection.setRequestProperty("Attributes", attributes);
    try {
      if (body != null) {
        connection.setRequestMethod("POST"); connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/json");
        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        connection.setFixedLengthStreamingMode(bytes.length);
        try (java.io.OutputStream output = connection.getOutputStream()) { output.write(bytes); }
      }
      if (connection.getResponseCode() != 200) throw new IOException("Travel unavailable");
      long deadline = System.nanoTime() + 12_000_000_000L;
      try (InputStream input = connection.getInputStream(); ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
        byte[] buffer = new byte[4096]; int count;
        while ((count = input.read(buffer)) != -1) {
          if (bytes.size() + count > 128 * 1024 || System.nanoTime() > deadline) throw new IOException("Travel unavailable");
          bytes.write(buffer, 0, count);
        }
        return new JSONObject(bytes.toString("UTF-8"));
      }
    } finally { connection.disconnect(); }
  }

  private static final class GeoCache {
    final JSONArray point; final long expires;
    GeoCache(JSONArray point, long expires) { this.point = point; this.expires = expires; }
  }
  private static final class RouteCache {
    final JSONObject value; final long nextCheck;
    RouteCache(JSONObject value, long nextCheck) { this.value = value; this.nextCheck = nextCheck; }
  }
}

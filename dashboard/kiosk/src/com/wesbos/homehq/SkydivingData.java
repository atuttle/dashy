package com.wesbos.homehq;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;

/** Native transport only. Rating rules, sunset times, and UI are shared JavaScript. */
final class SkydivingData {
  private static final long HOUR = 3600000;
  private static final String AVIATION_URL = "https://www.usairnet.com/cgi-bin/launch/code.cgi?state=PA&sta=KMDT";
  private static final String BASIC_URL = "https://api.pirateweather.net/forecast/dashy/40.2,-76.77?units=us&extend=hourly&exclude=currently,minutely,daily,alerts";
  private final ExecutorService pool = Executors.newFixedThreadPool(2);
  private final Cache aviation = new Cache(), basic = new Cache();
  private String configuredKey;

  void close() { pool.shutdownNow(); }

  synchronized JSONObject snapshot(String apiKey) throws Exception {
    if (configuredKey == null || !configuredKey.equals(apiKey)) {
      basic.value = null; basic.retryAt = 0; configuredKey = apiKey;
    }
    List<Callable<JSONObject>> tasks = new ArrayList<>();
    tasks.add(() -> read(aviation, AVIATION_URL, null, true));
    tasks.add(() -> apiKey == null || apiKey.isEmpty() ? null : read(basic, BASIC_URL, apiKey, false));
    List<Future<JSONObject>> values = pool.invokeAll(tasks);
    return new JSONObject().put("station", "KMDT").put("checkedAt", System.currentTimeMillis())
        .put("aviation", values.get(0).get() == null ? JSONObject.NULL : values.get(0).get())
        .put("basic", values.get(1).get() == null ? JSONObject.NULL : values.get(1).get());
  }

  private static final class Cache {
    JSONObject value;
    long retryAt;
    boolean error;
  }

  private static JSONObject read(Cache cache, String url, String key, boolean isAviation) throws Exception {
    long now = System.currentTimeMillis();
    if (now >= cache.retryAt) {
      try {
        String text = FrameData.download(url, key);
        JSONObject value = isAviation ? parseAviation(text, System.currentTimeMillis()) : parseBasic(text, System.currentTimeMillis());
        if (isAviation && (now - value.getLong("issuedAt") > 6 * HOUR || value.getLong("issuedAt") > now + HOUR)) {
          throw new IOException("Old model run");
        }
        cache.value = value; cache.error = false; cache.retryAt = System.currentTimeMillis() + HOUR;
      } catch (Exception ignored) {
        // Provider errors can contain request details. Never log them or send them to WebView.
        cache.error = true; cache.retryAt = System.currentTimeMillis() + 5 * 60000;
      }
    }
    if (cache.value == null || System.currentTimeMillis() - cache.value.getLong("fetchedAt") >= 2 * HOUR) return null;
    return new JSONObject(cache.value.toString()).put("stale", cache.error);
  }

  private static final Pattern DATA = Pattern.compile("<script\\b[^>]*\\bid=[\"']forecast-data[\"'][^>]*>([\\s\\S]*?)</script>", Pattern.CASE_INSENSITIVE);
  private static final Pattern SKY = Pattern.compile("<span\\b[^>]*class=[\"'][^\"']*\\bsky-name\\b[^\"']*[\"'][^>]*>([^<]*)</span>", Pattern.CASE_INSENSITIVE);

  static JSONObject parseAviation(String html, long fetchedAt) throws Exception {
    Matcher script = DATA.matcher(html);
    if (!script.find() || !Pattern.compile("KMDT\\s+NBM\\s+NBS GUIDANCE").matcher(html).find()) throw new IOException("Unexpected page");
    JSONObject data = new JSONObject(script.group(1));
    if (!"America/New_York".equals(data.getString("timezone")) || !"mph".equals(data.getString("windunit"))) throw new IOException("Unexpected units");
    JSONArray epochs = data.getJSONArray("epochs"), rows = data.getJSONArray("weather"), sources = data.getJSONArray("sources");
    if (epochs.length() == 0 || epochs.length() != rows.length() || epochs.length() != sources.length()) throw new IOException("Invalid timeline");
    Map<String, JSONArray> charts = new HashMap<>();
    JSONArray chartList = data.getJSONArray("charts");
    for (int i = 0; i < chartList.length(); i++) {
      JSONObject chart = chartList.getJSONObject(i);
      charts.put(chart.getString("key"), chart.getJSONArray("values"));
    }
    List<String> labels = new ArrayList<>();
    Matcher sky = SKY.matcher(html);
    while (sky.find()) labels.add(sky.group(1).trim());
    JSONArray points = new JSONArray();
    long issuedAt = Long.MAX_VALUE, previous = 0;
    for (int i = 0; i < rows.length(); i++) {
      JSONObject row = rows.getJSONObject(i), source = sources.getJSONObject(i);
      if (!"NBS".equals(source.getString("product"))) throw new IOException("Unexpected model");
      long time = epochs.getLong(i) * 1000, issued = source.getLong("issue") * 1000;
      if (time <= previous) throw new IOException("Invalid timeline");
      previous = time; issuedAt = Math.min(issuedAt, issued);
      String category = row.optString("CAT");
      points.put(new JSONObject().put("time", time).put("issuedAt", issued)
          // Chart values match the page's displayed mph/feet; weather.WSP/GST are knots.
          .put("windSpeedMph", display(charts.get("WSP"), i)).put("windGustMph", display(charts.get("GST"), i))
          .put("lowestCloudBaseFt", display(charts.get("LCB"), i)).put("unlimitedBase", "Unlimited".equals(row.optString("LCB")))
          .put("cloudCover", labels.size() == rows.length() ? labels.get(i) : JSONObject.NULL)
          .put("cloudCoverPercent", numeric(row.opt("SKY"), 100))
          .put("flightCategory", category.matches("VFR|MVFR|IFR|LIFR") ? category : JSONObject.NULL));
    }
    return new JSONObject().put("source", "USAirNet").put("fetchedAt", fetchedAt).put("issuedAt", issuedAt).put("points", points);
  }

  static JSONObject parseBasic(String text, long fetchedAt) throws Exception {
    JSONObject raw = new JSONObject(text);
    if (!"America/New_York".equals(raw.getString("timezone")) || !"us".equals(raw.getJSONObject("flags").getString("units"))) throw new IOException("Unexpected forecast");
    JSONArray rows = raw.getJSONObject("hourly").getJSONArray("data");
    List<JSONObject> points = new ArrayList<>();
    for (int i = 0; i < rows.length(); i++) {
      JSONObject row = rows.getJSONObject(i);
      if (!(row.opt("time") instanceof Number)) continue;
      points.add(new JSONObject().put("time", row.getLong("time") * 1000)
          .put("windSpeedMph", numeric(row.opt("windSpeed"), Double.MAX_VALUE))
          .put("windGustMph", numeric(row.opt("windGust"), Double.MAX_VALUE))
          .put("cloudCover", numeric(row.opt("cloudCover"), 1)).put("precipProbability", numeric(row.opt("precipProbability"), 1))
          .put("icon", row.opt("icon") instanceof String ? row.getString("icon") : JSONObject.NULL));
    }
    if (points.isEmpty()) throw new IOException("Empty forecast");
    Collections.sort(points, (a, b) -> Long.compare(a.optLong("time"), b.optLong("time")));
    return new JSONObject().put("source", "Pirate Weather").put("fetchedAt", fetchedAt).put("points", new JSONArray(points));
  }

  private static Object display(JSONArray values, int index) {
    Object raw = values == null ? null : values.opt(index);
    Object value = numeric(raw, Double.MAX_VALUE);
    return value == JSONObject.NULL ? value : Math.round(((Number) value).doubleValue());
  }

  private static Object numeric(Object raw, double maximum) {
    if (!(raw instanceof Number)) return JSONObject.NULL;
    double value = ((Number) raw).doubleValue();
    return Double.isNaN(value) || Double.isInfinite(value) || value < 0 || value > maximum ? JSONObject.NULL : value;
  }
}

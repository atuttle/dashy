package com.wesbos.homehq;

import android.content.Context;
import android.util.AtomicFile;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/** Native-only secret store. Never expose its contents through WebView or log messages. */
final class ConfigStore {
  static final int MAX_BYTES = 65536;
  private static final Object LOCK = new Object();
  private static boolean importing;
  private static boolean startupLoaded;
  private static String lastImport = "idle";

  private static AtomicFile file(Context context) {
    // App-private and excluded from Android's automatic backups.
    return new AtomicFile(new File(context.getNoBackupFilesDir(), "dashy-config.json"));
  }

  static void validate(byte[] bytes) throws Exception {
    if (bytes.length == 0 || bytes.length > MAX_BYTES) throw new IOException("Invalid config size");
    String text = StandardCharsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(bytes)).toString();
    JSONObject config = new JSONObject(text);
    if (config.getInt("version") != 1) throw new IOException("Unsupported config version");
    JSONArray calendars = config.getJSONArray("calendars");
    if (calendars.length() > 32) throw new IOException("Too many calendar feeds");
    Set<String> ids = new HashSet<>();
    for (int i = 0; i < calendars.length(); i++) {
      JSONObject calendar = calendars.getJSONObject(i);
      String id = string(calendar, "id");
      if (!id.matches("[a-z][a-z0-9-]{0,63}") || !ids.add(id)) throw new IOException("Invalid feed id");
      String owner = string(calendar, "calendar");
      if (!owner.equals("dad") && !owner.equals("mom") && !owner.equals("kiddo") && !owner.equals("family")) {
        throw new IOException("Unknown calendar owner");
      }
      URI uri = new URI(string(calendar, "url"));
      if (!"https".equals(uri.getScheme()) || uri.getHost() == null
          || uri.getRawUserInfo() != null || uri.getRawFragment() != null) {
        throw new IOException("Expected an HTTPS feed");
      }
    }
    if (config.has("weather")) {
      JSONObject weather = config.getJSONObject("weather");
      string(weather, "apiKey");
      double latitude = weather.getDouble("latitude"), longitude = weather.getDouble("longitude");
      if (Double.isNaN(latitude) || Double.isInfinite(latitude) || Math.abs(latitude) > 90
          || Double.isNaN(longitude) || Double.isInfinite(longitude) || Math.abs(longitude) > 180) {
        throw new IOException("Invalid coordinates");
      }
      if (!"us".equals(string(weather, "units"))) throw new IOException("Unsupported units");
    }
    if (config.has("photos")) PhotoData.validateAlbumUrl(string(config.getJSONObject("photos"), "albumUrl"));
    if (config.has("countdowns")) {
      URI uri = new URI(string(config.getJSONObject("countdowns"), "url"));
      if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getRawUserInfo() != null || uri.getRawFragment() != null) throw new IOException("Expected an HTTPS countdown feed");
    }
    if (config.has("travel")) {
      JSONObject travel = config.getJSONObject("travel");
      String address = string(travel, "homeAddress"), key = string(travel, "apiKey");
      if (!"tomtom".equals(string(travel, "provider")) || address.length() > 1024
          || address.matches("(?s).*[\\x00-\\x1f].*") || key.matches("(?s).*[\\x00-\\x1f].*")) throw new IOException("Invalid travel config");
    }
  }

  private static String string(JSONObject value, String key) throws Exception {
    Object raw = value.get(key);
    if (!(raw instanceof String) || ((String) raw).trim().isEmpty() || ((String) raw).length() > 4096) {
      throw new IOException("Invalid configuration field");
    }
    return (String) raw;
  }

  static boolean beginImport() {
    synchronized (LOCK) {
      if (importing) return false;
      importing = true;
      lastImport = "pending";
      return true;
    }
  }

  static void failImport() {
    synchronized (LOCK) { importing = false; lastImport = "error"; }
  }

  static void importFrom(Context context, InputStream input) {
    try {
      ByteArrayOutputStream bytes = new ByteArrayOutputStream();
      byte[] buffer = new byte[4096];
      int count;
      while ((count = input.read(buffer)) != -1) {
        if (bytes.size() + count > MAX_BYTES) throw new IOException("Config too large");
        bytes.write(buffer, 0, count);
      }
      byte[] content = bytes.toByteArray();
      validate(content);
      synchronized (LOCK) {
        AtomicFile target = file(context);
        FileOutputStream out = null;
        try {
          out = target.startWrite();
          out.write(content);
          target.finishWrite(out);
        } catch (Exception e) {
          if (out != null) target.failWrite(out);
          throw e;
        }
        importing = false;
        lastImport = "ok";
      }
    } catch (Exception ignored) {
      // JSON parser errors can contain secret text. Only expose a fixed error status.
      failImport();
    }
  }

  /** Available to native feed/weather code; intentionally not exposed by the provider. */
  static JSONObject load(Context context) {
    synchronized (LOCK) {
      try {
        byte[] bytes = file(context).readFully();
        validate(bytes);
        return new JSONObject(new String(bytes, StandardCharsets.UTF_8));
      } catch (Exception ignored) { return null; }
    }
  }

  static boolean loadAtStartup(Context context) {
    synchronized (LOCK) {
      startupLoaded = load(context) != null;
      return startupLoaded;
    }
  }

  static Status status(Context context) {
    synchronized (LOCK) {
      try {
        byte[] bytes = file(context).readFully();
        validate(bytes);
        JSONObject config = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
        StringBuilder hash = new StringBuilder();
        for (byte b : digest) hash.append(String.format("%02x", b & 0xff));
        return new Status(true, config.getJSONArray("calendars").length(), config.has("weather"), config.has("photos"), config.has("travel"), config.has("countdowns"), hash.toString(), lastImport, startupLoaded);
      } catch (Exception ignored) { return new Status(false, 0, false, false, false, false, "", lastImport, startupLoaded); }
    }
  }

  static String summary(Context context) {
    Status status = status(context);
    if (!status.configured) return "No private configuration imported.";
    return status.calendarCount + " calendar feeds\nWeather key: " + (status.weatherConfigured ? "configured" : "not configured")
        + "\nPhoto album: " + (status.photosConfigured ? "configured" : "not configured")
        + "\nTravel estimates: " + (status.travelConfigured ? "configured" : "not configured")
        + "\nCountdown calendar: " + (status.countdownsConfigured ? "configured" : "not configured")
        + "\n\nSaved on this frame. No laptop or sign-in needed at startup.";
  }

  static final class Status {
    final boolean configured, weatherConfigured, photosConfigured, travelConfigured, countdownsConfigured, startupLoaded;
    final int calendarCount;
    final String sha256, lastImport;
    Status(boolean configured, int calendarCount, boolean weatherConfigured, boolean photosConfigured, boolean travelConfigured, boolean countdownsConfigured, String sha256, String lastImport, boolean startupLoaded) {
      this.configured = configured; this.calendarCount = calendarCount;
      this.weatherConfigured = weatherConfigured; this.sha256 = sha256; this.lastImport = lastImport;
      this.photosConfigured = photosConfigured;
      this.travelConfigured = travelConfigured;
      this.countdownsConfigured = countdownsConfigured;
      this.startupLoaded = startupLoaded;
    }
  }
}

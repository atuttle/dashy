package com.wesbos.homehq;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import java.io.FileNotFoundException;
import java.io.InputStream;

/** USB provisioning endpoint restricted to the Android shell/system DUMP permission. */
public final class ConfigProvider extends ContentProvider {
  @Override public boolean onCreate() { return true; }

  @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
    if (!"/import".equals(uri.getPath()) || !"w".equals(mode)) throw new FileNotFoundException("Unsupported operation");
    if (!ConfigStore.beginImport()) throw new FileNotFoundException("Import already in progress");
    try {
      ParcelFileDescriptor[] pipe = ParcelFileDescriptor.createPipe();
      new Thread(() -> {
        try (InputStream input = new ParcelFileDescriptor.AutoCloseInputStream(pipe[0])) {
          ConfigStore.importFrom(getContext(), input);
        } catch (Exception ignored) { ConfigStore.failImport(); }
      }, "ConfigImport").start();
      return pipe[1];
    } catch (Exception ignored) {
      ConfigStore.failImport();
      throw new FileNotFoundException("Could not start import");
    }
  }

  @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String order) {
    if (!"/status".equals(uri.getPath())) throw new UnsupportedOperationException("Status only");
    ConfigStore.Status status = ConfigStore.status(getContext());
    MatrixCursor cursor = new MatrixCursor(new String[] {
        "configured", "calendar_count", "weather_configured", "sha256", "last_import", "loaded_at_startup", "photos_configured", "travel_configured", "countdowns_configured" });
    cursor.addRow(new Object[] { status.configured ? 1 : 0, status.calendarCount,
        status.weatherConfigured ? 1 : 0, status.sha256, status.lastImport, status.startupLoaded ? 1 : 0, status.photosConfigured ? 1 : 0, status.travelConfigured ? 1 : 0, status.countdownsConfigured ? 1 : 0 });
    return cursor;
  }

  @Override public String getType(Uri uri) { return "application/json"; }
  @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException("Import only"); }
  @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { throw new UnsupportedOperationException("Import only"); }
  @Override public int delete(Uri uri, String selection, String[] args) { throw new UnsupportedOperationException("Import only"); }
}

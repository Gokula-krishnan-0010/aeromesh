/**
 * withAeroMeshAndroid — Expo config plugin that injects the AeroMesh native
 * Android files and manifest entries during `npx expo prebuild`.
 *
 * Injects:
 *  1. ForegroundSensorService.java  — persistent foreground service (Req 8.1, 8.2, 8.5)
 *  2. AeroMeshHeadlessTaskService.java — HeadlessJS bridge (Req 8.4)
 *  3. BootReceiver.java             — auto-start on reboot (Req 8.3)
 *  4. AndroidManifest.xml entries   — <service> and <receiver> registrations
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6
 */

const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Java source files to inject
// ---------------------------------------------------------------------------

const JAVA_FILES = [
  {
    filename: 'ForegroundSensorService.java',
    content: `package com.aeromesh;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import com.facebook.react.HeadlessJsTaskService;
import com.facebook.react.bridge.Arguments;

/**
 * ForegroundSensorService — keeps the AeroMesh process alive after the user
 * swipes the app away. Invokes the AEROMESH_SENSOR_TASK HeadlessJS task every
 * 120 seconds (Requirements 8.1–8.6).
 */
public class ForegroundSensorService extends Service {

    private static final String TAG = "ForegroundSensorService";
    private static final int NOTIFICATION_ID = 1001;
    private static final String CHANNEL_ID = "aeromesh_sensor";
    private static final String HEADLESS_TASK_NAME = "AEROMESH_SENSOR_TASK";
    private static final long TASK_INTERVAL_MS = 120_000L;

    private Handler mHandler;
    private Runnable mSensorTaskRunnable;

    @Override
    public void onCreate() {
        super.onCreate();
        mHandler = new Handler(Looper.getMainLooper());
        mSensorTaskRunnable = new Runnable() {
            @Override
            public void run() {
                invokeSensorTask();
                mHandler.postDelayed(this, TASK_INTERVAL_MS);
            }
        };
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Log.i(TAG, "onStartCommand");
        createNotificationChannel();
        startForeground(NOTIFICATION_ID, buildNotification());
        mHandler.removeCallbacks(mSensorTaskRunnable);
        mHandler.post(mSensorTaskRunnable);
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (mHandler != null) mHandler.removeCallbacks(mSensorTaskRunnable);
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) { return null; }

    private void invokeSensorTask() {
        try {
            Intent taskIntent = new Intent(this, AeroMeshHeadlessTaskService.class);
            taskIntent.putExtra("taskKey", HEADLESS_TASK_NAME);
            taskIntent.putExtra("data", Arguments.createMap());
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(taskIntent);
            } else {
                startService(taskIntent);
            }
        } catch (Exception e) {
            Log.e(TAG, "HeadlessJS invocation failed: " + e.getMessage(), e);
        }
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "AeroMesh Sensor Service", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Monitors barometric pressure and relays SOS signals.");
            channel.setShowBadge(false);
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) manager.createNotificationChannel(channel);
        }
    }

    private Notification buildNotification() {
        Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent pendingIntent = PendingIntent.getActivity(this, 0,
            launchIntent != null ? launchIntent : new Intent(),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("AeroMesh Active")
            .setContentText("Monitoring barometric pressure and mesh network")
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setAutoCancel(false)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .build();
    }
}
`,
  },
  {
    filename: 'AeroMeshHeadlessTaskService.java',
    content: `package com.aeromesh;

import android.content.Intent;
import android.os.Bundle;
import android.util.Log;

import com.facebook.react.HeadlessJsTaskService;
import com.facebook.react.bridge.Arguments;
import com.facebook.react.jstasks.HeadlessJsTaskConfig;

import javax.annotation.Nullable;

/**
 * AeroMeshHeadlessTaskService — HeadlessJS service that runs the sensor task
 * JavaScript in a background context without a UI (Req 8.4).
 */
public class AeroMeshHeadlessTaskService extends HeadlessJsTaskService {

    private static final String TAG = "AeroMeshHeadlessTask";
    private static final long TASK_TIMEOUT_MS = 25_000L;

    @Nullable
    @Override
    protected HeadlessJsTaskConfig getTaskConfig(Intent intent) {
        Bundle extras = intent.getExtras();
        if (extras == null) return null;
        String taskKey = extras.getString("taskKey", "AEROMESH_SENSOR_TASK");
        Log.d(TAG, "Starting HeadlessJS task: " + taskKey);
        return new HeadlessJsTaskConfig(taskKey, Arguments.createMap(), TASK_TIMEOUT_MS, true);
    }
}
`,
  },
  {
    filename: 'BootReceiver.java',
    content: `package com.aeromesh;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

/**
 * BootReceiver — auto-starts ForegroundSensorService on device reboot (Req 8.3).
 */
public class BootReceiver extends BroadcastReceiver {

    private static final String TAG = "BootReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())
                || "android.intent.action.QUICKBOOT_POWERON".equals(intent.getAction())) {
            Log.i(TAG, "Boot completed — starting ForegroundSensorService");
            Intent serviceIntent = new Intent(context, ForegroundSensorService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(serviceIntent);
            } else {
                context.startService(serviceIntent);
            }
        }
    }
}
`,
  },
];

// ---------------------------------------------------------------------------
// Plugin: inject Java source files
// ---------------------------------------------------------------------------

function withAeroMeshJavaFiles(config) {
  return withDangerousMod(config, [
    'android',
    async (config) => {
      const projectRoot = config.modRequest.projectRoot;
      // Resolve the package directory from the applicationId or default
      const applicationId =
        config.android?.package || 'com.aeromesh';
      const packagePath = applicationId.replace(/\./g, '/');
      const javaDir = path.join(
        projectRoot,
        'android',
        'app',
        'src',
        'main',
        'java',
        packagePath
      );

      // Ensure the directory exists
      fs.mkdirSync(javaDir, { recursive: true });

      for (const file of JAVA_FILES) {
        const filePath = path.join(javaDir, file.filename);
        // Only write if the file doesn't already exist (don't overwrite manual edits)
        if (!fs.existsSync(filePath)) {
          fs.writeFileSync(filePath, file.content, 'utf8');
          console.log(`[withAeroMeshAndroid] Created ${file.filename}`);
        }
      }

      return config;
    },
  ]);
}

// ---------------------------------------------------------------------------
// Plugin: inject AndroidManifest.xml entries
// ---------------------------------------------------------------------------

function withAeroMeshManifest(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults;
    const application = manifest.manifest.application?.[0];

    if (!application) return config;

    // Ensure arrays exist
    if (!application.service) application.service = [];
    if (!application.receiver) application.receiver = [];

    // Helper: check if a component is already registered
    const hasComponent = (arr, name) =>
      arr.some((item) => item.$?.['android:name'] === name);

    // ---- ForegroundSensorService ----
    if (!hasComponent(application.service, '.ForegroundSensorService')) {
      application.service.push({
        $: {
          'android:name': '.ForegroundSensorService',
          'android:enabled': 'true',
          'android:exported': 'false',
          'android:foregroundServiceType': 'location',
        },
      });
    }

    // ---- AeroMeshHeadlessTaskService ----
    if (!hasComponent(application.service, '.AeroMeshHeadlessTaskService')) {
      application.service.push({
        $: {
          'android:name': '.AeroMeshHeadlessTaskService',
          'android:enabled': 'true',
          'android:exported': 'false',
        },
      });
    }

    // ---- BootReceiver ----
    if (!hasComponent(application.receiver, '.BootReceiver')) {
      application.receiver.push({
        $: {
          'android:name': '.BootReceiver',
          'android:enabled': 'true',
          'android:exported': 'true',
          'android:permission': 'android.permission.RECEIVE_BOOT_COMPLETED',
        },
        'intent-filter': [
          {
            $: { 'android:priority': '1000' },
            action: [
              { $: { 'android:name': 'android.intent.action.BOOT_COMPLETED' } },
              { $: { 'android:name': 'android.intent.action.QUICKBOOT_POWERON' } },
            ],
            category: [
              { $: { 'android:name': 'android.intent.category.DEFAULT' } },
            ],
          },
        ],
      });
    }

    return config;
  });
}

// ---------------------------------------------------------------------------
// Compose and export the plugin
// ---------------------------------------------------------------------------

module.exports = function withAeroMeshAndroid(config) {
  config = withAeroMeshJavaFiles(config);
  config = withAeroMeshManifest(config);
  return config;
};

package com.beembridge.www

import android.app.Activity
import android.provider.OpenableColumns
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class FileMetadataArgs {
    lateinit var uri: String
}

@TauriPlugin
class FileMetadataPlugin(private val activity: Activity) : Plugin(activity) {
    @Command
    fun getFileMetadata(invoke: Invoke) {
        val args = invoke.parseArgs(FileMetadataArgs::class.java)
        val uri = android.net.Uri.parse(args.uri)
        val result = JSObject()
        var name = ""
        var size = 0L

        try {
            activity.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    val sizeIdx = cursor.getColumnIndex(OpenableColumns.SIZE)
                    if (nameIdx >= 0) name = cursor.getString(nameIdx) ?: ""
                    if (sizeIdx >= 0) size = cursor.getLong(sizeIdx)
                }
            }
        } catch (_: Exception) {}

        result.put("name", name)
        result.put("size", size)
        invoke.resolve(result)
    }
}

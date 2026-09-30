package `in`.moneyapp.money

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * The Money app on Android: shows the same web app, and adds what a website can't do —
 * reading bank texts (only money messages are sent, to the person's own Google account).
 */
class MainActivity : Activity() {
    companion object { const val APP = "https://manuqwert1234.github.io/money-tracker/"; const val REQ_SMS = 7 }
    private lateinit var web: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = Color.BLACK
        web = WebView(this)
        web.setBackgroundColor(Color.BLACK)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.addJavascriptInterface(Bridge(), "MoneyAndroid")
        web.webViewClient = object : WebViewClient() {
            // Google sign-in and everything outside the app open in the phone's browser (Google blocks sign-in inside apps)
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                val u = req.url
                if (u.host == "manuqwert1234.github.io") return false
                startActivity(Intent(Intent.ACTION_VIEW, u)); return true
            }
        }
        setContentView(web)
        web.loadUrl(startUrl(intent))
    }

    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); web.loadUrl(startUrl(intent)) }

    /** moneyapp://setup?c=MNY1.xxx → open the app with the code filled in */
    private fun startUrl(i: Intent?): String {
        val c = i?.data?.takeIf { it.scheme == "moneyapp" }?.getQueryParameter("c")
        return if (c != null) APP + "#c=" + c else APP
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() { if (web.canGoBack()) web.goBack() else super.onBackPressed() }

    override fun onRequestPermissionsResult(code: Int, perms: Array<out String>, res: IntArray) {
        super.onRequestPermissionsResult(code, perms, res)
        if (code == REQ_SMS && hasPerm(Manifest.permission.READ_SMS)) SmsSender.importInbox(this) { added ->
            runOnUiThread { web.evaluateJavascript("window.onSmsImport && onSmsImport($added)", null) }
        }
        web.evaluateJavascript("window.render && render()", null)
    }

    private fun hasPerm(p: String) = checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED

    inner class Bridge {
        /** The web app hands over this person's private SMS link after they unlock with their PIN. */
        @JavascriptInterface fun setSmsLink(link: String) {
            val prefs = getSharedPreferences("money", Context.MODE_PRIVATE)
            val changed = prefs.getString("link", null) != link
            prefs.edit().putString("link", link).apply()
            if (changed && !hasPerm(Manifest.permission.RECEIVE_SMS)) runOnUiThread {
                requestPermissions(arrayOf(Manifest.permission.RECEIVE_SMS, Manifest.permission.READ_SMS), REQ_SMS)
            } else if (changed && hasPerm(Manifest.permission.READ_SMS)) SmsSender.importInbox(this@MainActivity) { }
        }
        @JavascriptInterface fun smsAllowed(): Boolean = hasPerm(Manifest.permission.RECEIVE_SMS)
        @JavascriptInterface fun requestSms() { runOnUiThread { requestPermissions(arrayOf(Manifest.permission.RECEIVE_SMS, Manifest.permission.READ_SMS), REQ_SMS) } }
        @JavascriptInterface fun openSettings() { runOnUiThread { startActivity(Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))) } }
        @JavascriptInterface fun clipboard(): String {
            val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            return cm.primaryClip?.getItemAt(0)?.coerceToText(this@MainActivity)?.toString() ?: ""
        }
        @JavascriptInterface fun lastSent(): String = getSharedPreferences("money", Context.MODE_PRIVATE).getString("last", "") ?: ""
    }
}

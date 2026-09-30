package `in`.moneyapp.money

import android.content.Context
import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

object SmsSender {
    private val MONEY = Regex("(?i)(rs\\.?\\s?\\d|inr\\s?\\d|₹\\s?\\d|debited|credited|spent|withdrawn|a/c|acct|upi)")
    private val PERSON = Regex("^\\+?\\d{10,13}$")   // texts from people's phone numbers are never sent

    /** Only bank-style messages: from a business sender (e.g. VM-HDFCBK) and mentioning money. */
    fun looksLikeMoney(from: String, body: String) = !PERSON.matches(from.replace(" ", "")) && MONEY.containsMatchIn(body)

    private fun link(ctx: Context) = ctx.getSharedPreferences("money", Context.MODE_PRIVATE).getString("link", null)

    private fun post(url: String, json: String): String {
        var u = URL(url)
        repeat(5) {   // Google answers with a redirect to the result
            val c = u.openConnection() as HttpURLConnection
            c.instanceFollowRedirects = false; c.connectTimeout = 15000; c.readTimeout = 30000
            if (it == 0) { c.requestMethod = "POST"; c.doOutput = true; c.setRequestProperty("Content-Type", "text/plain;charset=utf-8"); c.outputStream.use { o -> o.write(json.toByteArray()) } }
            val code = c.responseCode
            if (code in 300..399) { u = URL(u, c.getHeaderField("Location")); c.disconnect(); return@repeat }
            return (if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.readText() ?: ""
        }
        return ""
    }

    fun send(ctx: Context, text: String, whenMs: Long) {
        val l = link(ctx) ?: return
        for (attempt in 1..3) {
            try {
                val r = post(l, JSONObject().put("text", text).put("when", whenMs).toString())
                if (r.startsWith("{")) { ctx.getSharedPreferences("money", Context.MODE_PRIVATE).edit().putString("last", System.currentTimeMillis().toString()).apply(); return }
            } catch (_: Exception) { }
            Thread.sleep(3000L * attempt)
        }
    }

    /** First setup: send old bank texts already on the phone (last 3 years), in batches. */
    fun importInbox(ctx: Context, done: (Int) -> Unit) {
        val prefs = ctx.getSharedPreferences("money", Context.MODE_PRIVATE)
        val l = link(ctx) ?: return
        if (prefs.getString("imported", null) == l) return
        Thread {
            var added = 0
            try {
                val since = System.currentTimeMillis() - 3L * 365 * 86400000
                val items = mutableListOf<JSONObject>()
                ctx.contentResolver.query(Uri.parse("content://sms/inbox"), arrayOf("address", "body", "date"), "date > ?", arrayOf(since.toString()), "date ASC")?.use { c ->
                    while (c.moveToNext()) {
                        val from = c.getString(0) ?: ""; val body = c.getString(1) ?: ""
                        if (looksLikeMoney(from, body)) items.add(JSONObject().put("text", "$from: $body").put("when", c.getLong(2)))
                    }
                }
                for (chunk in items.chunked(300)) {
                    val r = post(l, JSONObject().put("items", JSONArray(chunk)).toString())
                    added += try { JSONObject(r).optInt("added", 0) } catch (_: Exception) { 0 }
                }
                prefs.edit().putString("imported", l).apply()
            } catch (_: Exception) { }
            done(added)
        }.start()
    }
}

package `in`.moneyapp.money

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony

/** A text arrived: if it looks like a bank/money message, send it to the person's own server. */
class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        val parts = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        // A long text arrives in several parts: join them per sender
        val bySender = parts.groupBy { it.originatingAddress ?: "" }
        val pending = goAsync()
        Thread {
            try {
                for ((from, ps) in bySender) {
                    val body = ps.joinToString("") { it.messageBody ?: "" }
                    if (SmsSender.looksLikeMoney(from, body)) SmsSender.send(ctx, "$from: $body", ps.first().timestampMillis)
                }
            } finally { pending.finish() }
        }.start()
    }
}

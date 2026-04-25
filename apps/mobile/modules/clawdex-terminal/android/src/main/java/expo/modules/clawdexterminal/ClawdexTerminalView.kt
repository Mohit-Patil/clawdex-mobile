package expo.modules.clawdexterminal

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.widget.TextView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

class ClawdexTerminalView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onReady by EventDispatcher()
  private val onInput by EventDispatcher()
  private val onTerminalResize by EventDispatcher()
  private val textView = TextView(context).apply {
    layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
    setBackgroundColor(Color.TRANSPARENT)
    setPadding(28, 28, 28, 28)
    setTextColor(Color.parseColor("#D1D5DB"))
    textSize = 13f
    typeface = Typeface.MONOSPACE
  }

  private var readyDispatched = false
  private var lastResizeSignature: String? = null
  private var lastAppliedWriteSeq = -1

  var sessionId: String? = null
    set(value) {
      field = value
      refreshDisplay()
      dispatchReadyIfNeeded()
    }

  var placeholderText: String = "Waiting for terminal output…"
    set(value) {
      field = value
      refreshDisplay()
    }

  var cols: Int = 80
    private set

  var rows: Int = 24
    private set

  init {
    setBackgroundColor(Color.parseColor("#101114"))
    addView(textView)
    refreshDisplay()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    dispatchReadyIfNeeded()
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    super.onLayout(changed, left, top, right, bottom)
    emitResizeSuggestionIfNeeded()
  }

  fun setGrid(cols: Int, rows: Int) {
    val nextCols = cols.coerceAtLeast(1)
    val nextRows = rows.coerceAtLeast(1)
    if (this.cols == nextCols && this.rows == nextRows) {
      return
    }

    this.cols = nextCols
    this.rows = nextRows
    refreshDisplay()
  }

  fun applyWriteFrame(frame: Map<String, Any?>?) {
    val seq = (frame?.get("seq") as? Number)?.toInt() ?: return
    if (seq <= lastAppliedWriteSeq) {
      return
    }

    lastAppliedWriteSeq = seq
    refreshDisplay()
  }

  private fun refreshDisplay() {
    val sessionSummary = sessionId?.let { "Session: $it" } ?: "Session: pending"
    textView.text = buildString {
      append(placeholderText)
      append("\n\n")
      append(sessionSummary)
      append("\n")
      append("Grid: ${cols}x${rows}")
      append("\n\n")
      append("Android is still on the placeholder renderer. The PTY transport is active, but libghostty-vt wiring is not added here yet.")
    }
  }

  private fun dispatchReadyIfNeeded() {
    if (readyDispatched || windowToken == null) {
      return
    }

    readyDispatched = true
    onReady(
      mapOf(
        "available" to false,
        "backend" to "android-placeholder",
        "message" to "Android is still using the placeholder renderer while iOS libghostty-vt work is wired up.",
        "sessionId" to sessionId
      )
    )
  }

  private fun emitResizeSuggestionIfNeeded() {
    val pixelWidth = width
    val pixelHeight = height
    if (pixelWidth <= 0 || pixelHeight <= 0) {
      return
    }

    val suggestedCols = (pixelWidth / 9).coerceAtLeast(2)
    val suggestedRows = (pixelHeight / 18).coerceAtLeast(1)
    val signature = "${suggestedCols}x${suggestedRows}:${pixelWidth}x${pixelHeight}"
    if (signature == lastResizeSignature) {
      return
    }

    lastResizeSignature = signature
    onTerminalResize(
      mapOf(
        "sessionId" to sessionId,
        "cols" to suggestedCols,
        "rows" to suggestedRows,
        "pixelWidth" to pixelWidth,
        "pixelHeight" to pixelHeight
      )
    )
  }
}

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <string>

#include <napi.h>

#include "ghostty_bridge.h"

namespace {

struct TerminalBindingState {
  AdhdevGhosttyTerminal* terminal = nullptr;
};

std::string BuildGhosttyErrorMessage(const char* context, int result) {
  return std::string(context) + ": " + adhdev_ghostty_result_message(result);
}

void ThrowGhosttyError(Napi::Env env, const char* context, int result) {
  Napi::Error::New(env, BuildGhosttyErrorMessage(context, result)).ThrowAsJavaScriptException();
}

void ThrowCodedError(Napi::Env env, const std::string& message, const char* code, bool range = false) {
  Napi::Error error = range ? Napi::RangeError::New(env, message) : Napi::Error::New(env, message);
  error.Value().Set("code", Napi::String::New(env, code));
  error.ThrowAsJavaScriptException();
}

TerminalBindingState* GetState(const Napi::CallbackInfo& info) {
  if (!info.Data()) {
    Napi::Error::New(info.Env(), "missing native terminal state").ThrowAsJavaScriptException();
    return nullptr;
  }
  return static_cast<TerminalBindingState*>(info.Data());
}

bool EnsureOpen(Napi::Env env, TerminalBindingState* state) {
  if (!state || !state->terminal) {
    Napi::Error::New(env, "ghostty terminal already disposed").ThrowAsJavaScriptException();
    return false;
  }
  return true;
}

void FinalizeState(Napi::Env, TerminalBindingState* state) {
  if (!state) return;
  if (state->terminal) {
    adhdev_ghostty_terminal_destroy(state->terminal);
    state->terminal = nullptr;
  }
  delete state;
}

Napi::Value Write(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  TerminalBindingState* state = GetState(info);
  if (!EnsureOpen(env, state)) return env.Undefined();
  if (info.Length() < 1) return env.Undefined();

  int result = ADHDEV_GHOSTTY_INVALID_VALUE;
  if (info[0].IsBuffer()) {
    Napi::Buffer<uint8_t> buffer = info[0].As<Napi::Buffer<uint8_t>>();
    result = adhdev_ghostty_terminal_write(state->terminal, buffer.Data(), buffer.Length());
  } else if (info[0].IsString()) {
    std::string text = info[0].As<Napi::String>().Utf8Value();
    result = adhdev_ghostty_terminal_write(
        state->terminal,
        reinterpret_cast<const uint8_t*>(text.data()),
        text.size());
  } else {
    Napi::TypeError::New(env, "write expects a string or Uint8Array buffer").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  if (result != ADHDEV_GHOSTTY_SUCCESS) {
    ThrowGhosttyError(env, "adhdev_ghostty_terminal_write", result);
  }
  return env.Undefined();
}

Napi::Value Resize(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  TerminalBindingState* state = GetState(info);
  if (!EnsureOpen(env, state)) return env.Undefined();
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
    Napi::TypeError::New(env, "resize expects cols and rows").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const uint16_t cols = static_cast<uint16_t>(std::max(1, info[0].As<Napi::Number>().Int32Value()));
  const uint16_t rows = static_cast<uint16_t>(std::max(1, info[1].As<Napi::Number>().Int32Value()));
  const int result = adhdev_ghostty_terminal_resize(state->terminal, cols, rows);
  if (result != ADHDEV_GHOSTTY_SUCCESS) {
    ThrowGhosttyError(env, "adhdev_ghostty_terminal_resize", result);
  }
  return env.Undefined();
}

Napi::Value FormatPlainText(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  TerminalBindingState* state = GetState(info);
  if (!EnsureOpen(env, state)) return env.Null();

  bool trim = false;
  if (info.Length() >= 1 && info[0].IsObject()) {
    Napi::Object options = info[0].As<Napi::Object>();
    if (options.Has("trim")) {
      trim = options.Get("trim").ToBoolean().Value();
    }
  }

  char* text = nullptr;
  size_t text_len = 0;
  const int result = adhdev_ghostty_terminal_format_plain_text(
      state->terminal,
      trim ? 1 : 0,
      &text,
      &text_len);
  if (result != ADHDEV_GHOSTTY_SUCCESS) {
    ThrowGhosttyError(env, "adhdev_ghostty_terminal_format_plain_text", result);
    return env.Null();
  }

  std::string output(text, text_len);
  adhdev_ghostty_terminal_free_text(text, text_len);
  return Napi::String::New(env, output);
}

Napi::Value FormatVT(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  TerminalBindingState* state = GetState(info);
  if (!EnsureOpen(env, state)) return env.Null();

  char* text = nullptr;
  size_t text_len = 0;
  const int result = adhdev_ghostty_terminal_format_vt(
      state->terminal,
      &text,
      &text_len);
  if (result != ADHDEV_GHOSTTY_SUCCESS) {
    ThrowGhosttyError(env, "adhdev_ghostty_terminal_format_vt", result);
    return env.Null();
  }

  std::string output(text, text_len);
  adhdev_ghostty_terminal_free_text(text, text_len);
  return Napi::String::New(env, output);
}

Napi::Value GetCursorPosition(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  TerminalBindingState* state = GetState(info);
  if (!EnsureOpen(env, state)) return env.Null();

  uint16_t col = 0;
  uint16_t row = 0;
  const int result = adhdev_ghostty_terminal_cursor_position(
      state->terminal,
      &col,
      &row);
  if (result != ADHDEV_GHOSTTY_SUCCESS) {
    ThrowGhosttyError(env, "adhdev_ghostty_terminal_cursor_position", result);
    return env.Null();
  }

  Napi::Object output = Napi::Object::New(env);
  output.Set("col", Napi::Number::New(env, col));
  output.Set("row", Napi::Number::New(env, row));
  return output;
}

constexpr uint64_t kMaxSafeInteger = 9007199254740991ULL;

const char* WideKindName(uint8_t wide) {
  switch (wide) {
    case ADHDEV_GHOSTTY_WIDE_WIDE:
      return "wide";
    case ADHDEV_GHOSTTY_WIDE_SPACER_TAIL:
      return "spacer-tail";
    case ADHDEV_GHOSTTY_WIDE_SPACER_HEAD:
      return "spacer-head";
    default:
      return "narrow";
  }
}

int WideWidth(uint8_t wide) {
  switch (wide) {
    case ADHDEV_GHOSTTY_WIDE_WIDE:
      return 2;
    case ADHDEV_GHOSTTY_WIDE_SPACER_TAIL:
    case ADHDEV_GHOSTTY_WIDE_SPACER_HEAD:
      return 0;
    default:
      return 1;
  }
}

Napi::Object RowToObject(Napi::Env env, const AdhdevGhosttyRowData& row, const char* space) {
  Napi::Object output = Napi::Object::New(env);
  output.Set("row", Napi::Number::New(env, row.row));
  output.Set("coordinateSpace", Napi::String::New(env, space));
  output.Set("text", Napi::String::New(env, row.text ? row.text : "", row.text_len));
  output.Set("wrapped", Napi::Boolean::New(env, row.wrapped));
  output.Set("wrapContinuation", Napi::Boolean::New(env, row.wrap_continuation));
  if (row.cells) {
    Napi::Array cells = Napi::Array::New(env, row.cell_count);
    for (size_t i = 0; i < row.cell_count; i++) {
      const AdhdevGhosttyCellInfo& info = row.cells[i];
      Napi::Object cell = Napi::Object::New(env);
      cell.Set("col", Napi::Number::New(env, static_cast<double>(i)));
      cell.Set("text", Napi::String::New(
          env,
          info.text_len ? row.cell_text + info.text_offset : "",
          info.text_len));
      cell.Set("width", Napi::Number::New(env, WideWidth(info.wide)));
      cell.Set("wideKind", Napi::String::New(env, WideKindName(info.wide)));
      cells.Set(static_cast<uint32_t>(i), cell);
    }
    output.Set("cells", cells);
  }
  return output;
}

// Reads an optional boolean option, rejecting non-boolean values instead of
// coercing them.
bool ReadBoolOption(Napi::Env env, const Napi::Object& options, const char* name, bool* out) {
  if (!options.Has(name)) return true;
  Napi::Value value = options.Get(name);
  if (value.IsUndefined()) return true;
  if (!value.IsBoolean()) {
    Napi::TypeError::New(env, std::string(name) + " must be a boolean").ThrowAsJavaScriptException();
    return false;
  }
  *out = value.As<Napi::Boolean>().Value();
  return true;
}

bool ReadOptionsObject(Napi::Env env, const Napi::CallbackInfo& info, size_t index, Napi::Object* out) {
  if (info.Length() <= index || info[index].IsUndefined() || info[index].IsNull()) {
    *out = Napi::Object::New(env);
    return true;
  }
  if (!info[index].IsObject()) {
    Napi::TypeError::New(env, "options must be an object").ThrowAsJavaScriptException();
    return false;
  }
  *out = info[index].As<Napi::Object>();
  return true;
}

// Snapshot of the ACTIVE area: metadata, cursor and (optionally) rows all come
// from one native call, so they describe the same terminal state.
Napi::Value GetViewport(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  TerminalBindingState* state = GetState(info);
  if (!EnsureOpen(env, state)) return env.Null();

  Napi::Object options;
  if (!ReadOptionsObject(env, info, 0, &options)) return env.Null();
  int include_rows = ADHDEV_GHOSTTY_ROWS_NONE;
  if (options.Has("includeRows") && !options.Get("includeRows").IsUndefined()) {
    Napi::Value value = options.Get("includeRows");
    const std::string mode = value.IsString() ? value.As<Napi::String>().Utf8Value() : "";
    if (mode == "none") {
      include_rows = ADHDEV_GHOSTTY_ROWS_NONE;
    } else if (mode == "cursor") {
      include_rows = ADHDEV_GHOSTTY_ROWS_CURSOR;
    } else if (mode == "all") {
      include_rows = ADHDEV_GHOSTTY_ROWS_ALL;
    } else {
      Napi::TypeError::New(env, "includeRows must be 'none', 'cursor' or 'all'").ThrowAsJavaScriptException();
      return env.Null();
    }
  }
  bool cells = false;
  if (!ReadBoolOption(env, options, "cells", &cells)) return env.Null();

  AdhdevGhosttyViewport* viewport = nullptr;
  const int result = adhdev_ghostty_terminal_get_viewport(
      state->terminal, include_rows, cells ? 1 : 0, &viewport);
  if (result != ADHDEV_GHOSTTY_SUCCESS) {
    ThrowGhosttyError(env, "adhdev_ghostty_terminal_get_viewport", result);
    return env.Null();
  }

  const uint64_t total = viewport->scrollbar_total;
  const uint64_t offset = viewport->scrollbar_offset;
  const uint64_t len = viewport->scrollbar_len;
  const uint64_t rows = viewport->rows;
  // The derived origins below are only meaningful for a self-consistent
  // scrollbar; report the inconsistency instead of clamping it into a
  // plausible-looking answer.
  if (total > kMaxSafeInteger || viewport->revision > kMaxSafeInteger || total < rows || len != rows ||
      offset > total - len) {
    adhdev_ghostty_viewport_free(viewport);
    ThrowCodedError(env, "ghostty scrollbar state is inconsistent with the terminal size", "ERR_GHOSTTY_SCROLLBAR_STATE");
    return env.Null();
  }
  const uint64_t active_origin = total - rows;
  const uint64_t cursor_screen_row = active_origin + viewport->cursor_row;

  Napi::Object output = Napi::Object::New(env);
  output.Set("revision", Napi::Number::New(env, static_cast<double>(viewport->revision)));
  output.Set("coordinateSpace", Napi::String::New(env, "active"));
  output.Set("rows", Napi::Number::New(env, viewport->rows));
  output.Set("cols", Napi::Number::New(env, viewport->cols));
  output.Set("cursorRow", Napi::Number::New(env, viewport->cursor_row));
  output.Set("cursorCol", Napi::Number::New(env, viewport->cursor_col));
  output.Set("cursorPendingWrap", Napi::Boolean::New(env, viewport->cursor_pending_wrap));
  output.Set("cursorVisible", Napi::Boolean::New(env, viewport->cursor_visible));
  output.Set("activeScreen", Napi::String::New(env, viewport->active_screen ? "alternate" : "primary"));
  Napi::Object scrollbar = Napi::Object::New(env);
  scrollbar.Set("total", Napi::Number::New(env, static_cast<double>(total)));
  scrollbar.Set("offset", Napi::Number::New(env, static_cast<double>(offset)));
  scrollbar.Set("len", Napi::Number::New(env, static_cast<double>(len)));
  output.Set("scrollbar", scrollbar);
  output.Set("scrollbackRows", Napi::Number::New(env, static_cast<double>(total - len)));
  output.Set("activeOriginRow", Napi::Number::New(env, static_cast<double>(active_origin)));
  output.Set("viewportOriginRow", Napi::Number::New(env, static_cast<double>(offset)));
  output.Set("viewportScrollbackOffset", Napi::Number::New(env, static_cast<double>(active_origin - offset)));
  if (cursor_screen_row >= offset && cursor_screen_row - offset < rows) {
    output.Set("cursorViewportRow", Napi::Number::New(env, static_cast<double>(cursor_screen_row - offset)));
  } else {
    output.Set("cursorViewportRow", env.Null());
  }
  if (viewport->lines) {
    Napi::Array lines = Napi::Array::New(env, viewport->line_count);
    for (size_t i = 0; i < viewport->line_count; i++) {
      lines.Set(static_cast<uint32_t>(i), RowToObject(env, viewport->lines[i], "active"));
    }
    output.Set("lines", lines);
  }
  adhdev_ghostty_viewport_free(viewport);
  return output;
}

Napi::Value ReadRow(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  TerminalBindingState* state = GetState(info);
  if (!EnsureOpen(env, state)) return env.Null();

  // Validate before any narrowing cast: a fractional, negative or huge index
  // must not silently become some other row.
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "readRow expects a row number").ThrowAsJavaScriptException();
    return env.Null();
  }
  const double row_value = info[0].As<Napi::Number>().DoubleValue();
  if (!std::isfinite(row_value) || std::floor(row_value) != row_value || row_value < 0 || row_value > 65535) {
    ThrowCodedError(env, "row must be an integer within the terminal", "ERR_GHOSTTY_ROW_OUT_OF_RANGE", true);
    return env.Null();
  }

  Napi::Object options;
  if (!ReadOptionsObject(env, info, 1, &options)) return env.Null();
  bool cells = false;
  if (!ReadBoolOption(env, options, "cells", &cells)) return env.Null();
  int space = ADHDEV_GHOSTTY_SPACE_ACTIVE;
  const char* space_name = "active";
  if (options.Has("space") && !options.Get("space").IsUndefined()) {
    Napi::Value value = options.Get("space");
    const std::string name = value.IsString() ? value.As<Napi::String>().Utf8Value() : "";
    if (name == "active") {
      space = ADHDEV_GHOSTTY_SPACE_ACTIVE;
    } else if (name == "viewport") {
      space = ADHDEV_GHOSTTY_SPACE_VIEWPORT;
      space_name = "viewport";
    } else {
      Napi::TypeError::New(env, "space must be 'active' or 'viewport'").ThrowAsJavaScriptException();
      return env.Null();
    }
  }
  bool has_expected = false;
  double expected = 0;
  if (options.Has("expectedRevision") && !options.Get("expectedRevision").IsUndefined()) {
    Napi::Value value = options.Get("expectedRevision");
    if (!value.IsNumber()) {
      Napi::TypeError::New(env, "expectedRevision must be a number").ThrowAsJavaScriptException();
      return env.Null();
    }
    has_expected = true;
    expected = value.As<Napi::Number>().DoubleValue();
  }

  if (has_expected) {
    const double current = static_cast<double>(adhdev_ghostty_terminal_revision(state->terminal));
    if (current != expected) {
      ThrowCodedError(env, "terminal changed since the expected revision", "ERR_GHOSTTY_STALE_REVISION");
      return env.Null();
    }
  }

  AdhdevGhosttyRowData row = {};
  uint64_t revision = 0;
  const int result = adhdev_ghostty_terminal_read_row(
      state->terminal, space, static_cast<uint16_t>(row_value), cells ? 1 : 0, &row, &revision);
  if (result == ADHDEV_GHOSTTY_ROW_OUT_OF_RANGE) {
    ThrowCodedError(env, "row must be an integer within the terminal", "ERR_GHOSTTY_ROW_OUT_OF_RANGE", true);
    return env.Null();
  }
  if (result != ADHDEV_GHOSTTY_SUCCESS) {
    ThrowGhosttyError(env, "adhdev_ghostty_terminal_read_row", result);
    return env.Null();
  }
  Napi::Object output = RowToObject(env, row, space_name);
  output.Set("revision", Napi::Number::New(env, static_cast<double>(revision)));
  adhdev_ghostty_row_data_release(&row);
  return output;
}

Napi::Value ScrollViewport(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  TerminalBindingState* state = GetState(info);
  if (!EnsureOpen(env, state)) return env.Undefined();

  int behavior = -1;
  int64_t delta = 0;
  if (info.Length() >= 1 && info[0].IsString()) {
    const std::string target = info[0].As<Napi::String>().Utf8Value();
    if (target == "top") behavior = ADHDEV_GHOSTTY_SCROLL_TOP;
    if (target == "bottom") behavior = ADHDEV_GHOSTTY_SCROLL_BOTTOM;
  } else if (info.Length() >= 1 && info[0].IsNumber()) {
    const double value = info[0].As<Napi::Number>().DoubleValue();
    if (std::isfinite(value) && std::floor(value) == value && std::fabs(value) <= 1e9) {
      behavior = ADHDEV_GHOSTTY_SCROLL_DELTA;
      delta = static_cast<int64_t>(value);
    }
  }
  if (behavior < 0) {
    Napi::TypeError::New(env, "scrollViewport expects 'top', 'bottom' or an integer row delta").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const int result = adhdev_ghostty_terminal_scroll_viewport(state->terminal, behavior, delta);
  if (result != ADHDEV_GHOSTTY_SUCCESS) {
    ThrowGhosttyError(env, "adhdev_ghostty_terminal_scroll_viewport", result);
  }
  return env.Undefined();
}

Napi::Value Dispose(const Napi::CallbackInfo& info) {
  TerminalBindingState* state = GetState(info);
  if (state && state->terminal) {
    adhdev_ghostty_terminal_destroy(state->terminal);
    state->terminal = nullptr;
  }
  return info.Env().Undefined();
}

Napi::Value CreateTerminal(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "options object is required").ThrowAsJavaScriptException();
    return env.Null();
  }

  const Napi::Object options = info[0].As<Napi::Object>();
  const uint16_t cols = static_cast<uint16_t>(std::max(1, options.Get("cols").ToNumber().Int32Value()));
  const uint16_t rows = static_cast<uint16_t>(std::max(1, options.Get("rows").ToNumber().Int32Value()));
  const size_t scrollback = options.Has("scrollback")
      ? static_cast<size_t>(std::max<int64_t>(0, options.Get("scrollback").ToNumber().Int64Value()))
      : 2000;

  auto* state = new TerminalBindingState();
  const int result = adhdev_ghostty_terminal_create(cols, rows, scrollback, &state->terminal);
  if (result != ADHDEV_GHOSTTY_SUCCESS) {
    delete state;
    ThrowGhosttyError(env, "adhdev_ghostty_terminal_create", result);
    return env.Null();
  }

  Napi::Object object = Napi::Object::New(env);
  Napi::External<TerminalBindingState> external = Napi::External<TerminalBindingState>::New(env, state, FinalizeState);
  object.Set("_native", external);
  object.Set("write", Napi::Function::New(env, Write, "write", state));
  object.Set("resize", Napi::Function::New(env, Resize, "resize", state));
  object.Set("formatPlainText", Napi::Function::New(env, FormatPlainText, "formatPlainText", state));
  object.Set("formatVT", Napi::Function::New(env, FormatVT, "formatVT", state));
  object.Set("getCursorPosition", Napi::Function::New(env, GetCursorPosition, "getCursorPosition", state));
  object.Set("getViewport", Napi::Function::New(env, GetViewport, "getViewport", state));
  object.Set("readRow", Napi::Function::New(env, ReadRow, "readRow", state));
  object.Set("scrollViewport", Napi::Function::New(env, ScrollViewport, "scrollViewport", state));
  object.Set("dispose", Napi::Function::New(env, Dispose, "dispose", state));
  return object;
}

#ifndef ADHDEV_GHOSTTY_SOURCE_DIGEST
#define ADHDEV_GHOSTTY_SOURCE_DIGEST ""
#endif
#ifndef ADHDEV_GHOSTTY_GIT_TAG
#define ADHDEV_GHOSTTY_GIT_TAG ""
#endif

// Provenance of this compiled binary. sourceDigest is computed by CMake from
// the binding sources at build time (scripts/binding-digest.mjs reproduces it),
// so a prebuilt can be matched against the sources it claims to implement.
Napi::Value GetBindingInfo(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object output = Napi::Object::New(env);
  output.Set("apiLevel", Napi::Number::New(env, ADHDEV_GHOSTTY_API_LEVEL));
  output.Set("sourceDigest", Napi::String::New(env, ADHDEV_GHOSTTY_SOURCE_DIGEST));
  output.Set("ghosttyRevision", Napi::String::New(env, ADHDEV_GHOSTTY_GIT_TAG));
  output.Set("napiVersion", Napi::Number::New(env, NAPI_VERSION));
  return output;
}

}  // namespace

Napi::Object InitAddon(Napi::Env env, Napi::Object exports) {
  exports.Set("createTerminal", Napi::Function::New(env, CreateTerminal));
  exports.Set("getBindingInfo", Napi::Function::New(env, GetBindingInfo));
  return exports;
}

NODE_API_MODULE(ghostty_vt_node, InitAddon)

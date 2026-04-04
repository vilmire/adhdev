#include <algorithm>
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
  object.Set("dispose", Napi::Function::New(env, Dispose, "dispose", state));
  return object;
}

}  // namespace

Napi::Object InitAddon(Napi::Env env, Napi::Object exports) {
  exports.Set("createTerminal", Napi::Function::New(env, CreateTerminal));
  return exports;
}

NODE_API_MODULE(ghostty_vt_node, InitAddon)

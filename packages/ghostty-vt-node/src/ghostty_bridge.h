#ifndef ADHDEV_GHOSTTY_BRIDGE_H
#define ADHDEV_GHOSTTY_BRIDGE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct AdhdevGhosttyTerminal AdhdevGhosttyTerminal;

#define ADHDEV_GHOSTTY_SUCCESS 0
#define ADHDEV_GHOSTTY_INVALID_VALUE -2

int adhdev_ghostty_terminal_create(
    uint16_t cols,
    uint16_t rows,
    size_t scrollback,
    AdhdevGhosttyTerminal** out_terminal);

int adhdev_ghostty_terminal_write(
    AdhdevGhosttyTerminal* terminal,
    const uint8_t* data,
    size_t len);

int adhdev_ghostty_terminal_resize(
    AdhdevGhosttyTerminal* terminal,
    uint16_t cols,
    uint16_t rows);

int adhdev_ghostty_terminal_format_plain_text(
    AdhdevGhosttyTerminal* terminal,
    int trim,
    char** out_text,
    size_t* out_len);

void adhdev_ghostty_terminal_free_text(char* text, size_t len);
void adhdev_ghostty_terminal_destroy(AdhdevGhosttyTerminal* terminal);
const char* adhdev_ghostty_result_message(int result);

#ifdef __cplusplus
}
#endif

#endif

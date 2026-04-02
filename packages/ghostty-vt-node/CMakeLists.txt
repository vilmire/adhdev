cmake_minimum_required(VERSION 3.20)
project(ghostty_vt_node LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

include(FetchContent)

execute_process(
  COMMAND node -p "require('node-addon-api').include"
  WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
  OUTPUT_VARIABLE NODE_ADDON_API_DIR
  OUTPUT_STRIP_TRAILING_WHITESPACE
)
string(REPLACE "\"" "" NODE_ADDON_API_DIR "${NODE_ADDON_API_DIR}")

set(GHOSTTY_GIT_TAG "d4a38c8661453026bd1b1bb022ba2c37b347adce" CACHE STRING "Ghostty git revision for libghostty-vt")

if(DEFINED ENV{ZIG_EXECUTABLE} AND NOT DEFINED ZIG_EXECUTABLE)
  set(ZIG_EXECUTABLE "$ENV{ZIG_EXECUTABLE}" CACHE FILEPATH "Path to zig executable")
endif()

FetchContent_Declare(ghostty
  GIT_REPOSITORY https://github.com/ghostty-org/ghostty.git
  GIT_TAG ${GHOSTTY_GIT_TAG}
)
FetchContent_MakeAvailable(ghostty)

add_library(${PROJECT_NAME} SHARED
  src/addon.cc
  src/ghostty_bridge.c
)

set(GHOSTTY_VT_RUNTIME_ALIAS "${CMAKE_SHARED_LIBRARY_PREFIX}ghostty-vt${CMAKE_SHARED_LIBRARY_SUFFIX}")

target_include_directories(${PROJECT_NAME} PRIVATE
  ${CMAKE_JS_INC}
  ${NODE_ADDON_API_DIR}
)

target_compile_definitions(${PROJECT_NAME} PRIVATE
  NAPI_DISABLE_CPP_EXCEPTIONS
  GHOSTTY_STATIC
)

target_link_libraries(${PROJECT_NAME} PRIVATE
  ${CMAKE_JS_LIB}
  ghostty-vt
)

set_target_properties(${PROJECT_NAME} PROPERTIES
  PREFIX ""
  SUFFIX ".node"
)

if(MSVC)
  # cmake-js injects CMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded (/MT) globally.
  # Node.js addons must use /MD (dynamic CRT) to match node.exe.
  # Override to MultiThreadedDLL, suppress static CRT, and explicitly link the
  # three dynamic-CRT import libs (msvcrt/vcruntime/ucrt) that the auto-link
  # mechanism may not pick up when cmake-js has overridden the global setting.
  set_target_properties(${PROJECT_NAME} PROPERTIES
    MSVC_RUNTIME_LIBRARY "MultiThreadedDLL"
  )
  target_link_options(${PROJECT_NAME} PRIVATE
    /NODEFAULTLIB:LIBCMT
    /NODEFAULTLIB:LIBCMTD
  )
  target_link_libraries(${PROJECT_NAME} PRIVATE msvcrt vcruntime ucrt)
endif()

if(APPLE)
  set_target_properties(${PROJECT_NAME} PROPERTIES
    BUILD_RPATH "@loader_path"
    INSTALL_RPATH "@loader_path"
  )
  target_link_options(${PROJECT_NAME} PRIVATE "-undefined dynamic_lookup")
elseif(UNIX)
  set_target_properties(${PROJECT_NAME} PROPERTIES
    BUILD_RPATH "$ORIGIN"
    INSTALL_RPATH "$ORIGIN"
  )
endif()

add_custom_command(TARGET ${PROJECT_NAME} POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
    $<TARGET_FILE:ghostty-vt>
    $<TARGET_FILE_DIR:${PROJECT_NAME}>/$<TARGET_FILE_NAME:ghostty-vt>
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
    $<TARGET_FILE:ghostty-vt>
    $<TARGET_FILE_DIR:${PROJECT_NAME}>/${GHOSTTY_VT_RUNTIME_ALIAS}
)

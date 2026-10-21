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

# --- Build provenance ---------------------------------------------------------
# A release binary must be built from exactly the pinned ghostty revision, from
# a clean checkout, with the pinned zig. Each violation is a problem code; any
# problem fails the configure step unless the explicit developer override
# ADHDEV_GHOSTTY_UNVERIFIED_DEV_BUILD=1 (cache variable or environment) is set.
# Then the binary reports releaseEligible=false and the prebuilt release gates
# refuse it. Only problem codes are embedded, never paths.
#
# toolchain.json is the single zig pin: the native workflow installs that
# version and the release gate compares against it. It is a binding digest
# input, so changing the pin invalidates every existing prebuilt.
file(READ "${CMAKE_CURRENT_SOURCE_DIR}/toolchain.json" ADHDEV_TOOLCHAIN_JSON)
string(JSON ADHDEV_PINNED_ZIG_VERSION GET "${ADHDEV_TOOLCHAIN_JSON}" zig)

set(ADHDEV_GHOSTTY_UNVERIFIED_DEV_BUILD OFF CACHE BOOL "Allow a non-release build from an unverified ghostty source or toolchain")
if("$ENV{ADHDEV_GHOSTTY_UNVERIFIED_DEV_BUILD}" STREQUAL "1")
  set(ADHDEV_GHOSTTY_UNVERIFIED_DEV_BUILD ON)
endif()
set(ADHDEV_PROVENANCE_PROBLEMS "")

# User-supplied extra zig flags change the library ghostty builds.
if(NOT "${GHOSTTY_ZIG_BUILD_FLAGS}" STREQUAL "")
  list(APPEND ADHDEV_PROVENANCE_PROBLEMS "extra-zig-build-flags")
endif()

# Resolve zig here (ghostty's own find_program reuses this cache entry) and
# record the version that actually builds libghostty-vt.
find_program(ZIG_EXECUTABLE zig REQUIRED)
execute_process(
  COMMAND "${ZIG_EXECUTABLE}" version
  OUTPUT_VARIABLE ADHDEV_ZIG_VERSION
  OUTPUT_STRIP_TRAILING_WHITESPACE
  RESULT_VARIABLE zig_version_result
)
string(REGEX REPLACE "[^0-9A-Za-z.+-]" "" ADHDEV_ZIG_VERSION "${ADHDEV_ZIG_VERSION}")
if(NOT zig_version_result EQUAL 0 OR NOT ADHDEV_ZIG_VERSION STREQUAL ADHDEV_PINNED_ZIG_VERSION)
  list(APPEND ADHDEV_PROVENANCE_PROBLEMS "zig-version-mismatch")
endif()

FetchContent_Declare(ghostty
  GIT_REPOSITORY https://github.com/ghostty-org/ghostty.git
  GIT_TAG ${GHOSTTY_GIT_TAG}
)
FetchContent_MakeAvailable(ghostty)

# The DECLARED tag proves nothing: FETCHCONTENT_SOURCE_DIR_GHOSTTY can point at
# any checkout. Verify the source that is actually built.
find_package(Git QUIET)
set(ADHDEV_GHOSTTY_SOURCE_REVISION "")
set(ADHDEV_GHOSTTY_SOURCE_CLEAN 0)
if(GIT_EXECUTABLE)
  execute_process(
    COMMAND "${GIT_EXECUTABLE}" -C "${ghostty_SOURCE_DIR}" rev-parse HEAD
    OUTPUT_VARIABLE ghostty_head
    OUTPUT_STRIP_TRAILING_WHITESPACE
    RESULT_VARIABLE ghostty_head_result
    ERROR_QUIET
  )
  execute_process(
    COMMAND "${GIT_EXECUTABLE}" -C "${ghostty_SOURCE_DIR}" status --porcelain
    OUTPUT_VARIABLE ghostty_status
    OUTPUT_STRIP_TRAILING_WHITESPACE
    RESULT_VARIABLE ghostty_status_result
    ERROR_QUIET
  )
  if(ghostty_head_result EQUAL 0 AND ghostty_head MATCHES "^[0-9a-f]+$")
    set(ADHDEV_GHOSTTY_SOURCE_REVISION "${ghostty_head}")
  endif()
  if(ghostty_status_result EQUAL 0 AND ghostty_status STREQUAL "")
    set(ADHDEV_GHOSTTY_SOURCE_CLEAN 1)
  endif()
endif()
if(ADHDEV_GHOSTTY_SOURCE_REVISION STREQUAL "")
  list(APPEND ADHDEV_PROVENANCE_PROBLEMS "ghostty-source-not-a-git-checkout")
elseif(NOT ADHDEV_GHOSTTY_SOURCE_REVISION STREQUAL GHOSTTY_GIT_TAG)
  list(APPEND ADHDEV_PROVENANCE_PROBLEMS "ghostty-head-mismatch")
endif()
if(NOT ADHDEV_GHOSTTY_SOURCE_CLEAN)
  list(APPEND ADHDEV_PROVENANCE_PROBLEMS "ghostty-source-dirty")
endif()

if(ADHDEV_PROVENANCE_PROBLEMS)
  if(NOT ADHDEV_GHOSTTY_UNVERIFIED_DEV_BUILD)
    message(FATAL_ERROR
      "ghostty-vt-node build provenance check failed: ${ADHDEV_PROVENANCE_PROBLEMS}\n"
      "  ghostty pin ${GHOSTTY_GIT_TAG}, resolved '${ADHDEV_GHOSTTY_SOURCE_REVISION}' (clean=${ADHDEV_GHOSTTY_SOURCE_CLEAN})\n"
      "  zig pin ${ADHDEV_PINNED_ZIG_VERSION} (toolchain.json), found '${ADHDEV_ZIG_VERSION}'\n"
      "Fix the toolchain/source, or set ADHDEV_GHOSTTY_UNVERIFIED_DEV_BUILD=1 for a local NON-RELEASE build "
      "(the prebuilt release gates refuse it).")
  endif()
  message(WARNING "ghostty-vt-node: NON-RELEASE build (${ADHDEV_PROVENANCE_PROBLEMS})")
  set(ADHDEV_GHOSTTY_RELEASE_ELIGIBLE 0)
else()
  set(ADHDEV_GHOSTTY_RELEASE_ELIGIBLE 1)
endif()
string(REPLACE ";" "," ADHDEV_PROVENANCE_PROBLEMS_TEXT "${ADHDEV_PROVENANCE_PROBLEMS}")
message(STATUS "ghostty-vt-node provenance: ghostty ${ADHDEV_GHOSTTY_SOURCE_REVISION} clean=${ADHDEV_GHOSTTY_SOURCE_CLEAN} zig ${ADHDEV_ZIG_VERSION} release=${ADHDEV_GHOSTTY_RELEASE_ELIGIBLE}")

add_library(${PROJECT_NAME} SHARED
  src/addon.cc
  src/ghostty_bridge.c
)

set(GHOSTTY_VT_RUNTIME_ALIAS "${CMAKE_SHARED_LIBRARY_PREFIX}ghostty-vt${CMAKE_SHARED_LIBRARY_SUFFIX}")

target_include_directories(${PROJECT_NAME} PRIVATE
  ${CMAKE_JS_INC}
  ${NODE_ADDON_API_DIR}
)

# Binding source digest, embedded so a compiled binary can be matched against
# the sources it was built from. scripts/binding-digest.mjs implements the same
# algorithm: per file "<path>:<sha256 of LF-normalized content>\n", in this
# order, then sha256 of the concatenation. Reconfigure whenever an input
# changes so an incremental compile never embeds a stale digest.
set(ADHDEV_BINDING_DIGEST_INPUTS
  CMakeLists.txt
  toolchain.json
  src/addon.cc
  src/ghostty_bridge.c
  src/ghostty_bridge.h
)
set(ADHDEV_BINDING_DIGEST_MANIFEST "")
foreach(input IN LISTS ADHDEV_BINDING_DIGEST_INPUTS)
  file(READ "${CMAKE_CURRENT_SOURCE_DIR}/${input}" input_content)
  string(REPLACE "\r\n" "\n" input_content "${input_content}")
  string(SHA256 input_hash "${input_content}")
  string(APPEND ADHDEV_BINDING_DIGEST_MANIFEST "${input}:${input_hash}\n")
  set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/${input}")
endforeach()
string(SHA256 ADHDEV_BINDING_SOURCE_DIGEST "${ADHDEV_BINDING_DIGEST_MANIFEST}")
message(STATUS "ghostty-vt-node binding source digest: ${ADHDEV_BINDING_SOURCE_DIGEST}")

target_compile_definitions(${PROJECT_NAME} PRIVATE
  NAPI_DISABLE_CPP_EXCEPTIONS
  NAPI_VERSION=8
  GHOSTTY_STATIC
  ADHDEV_GHOSTTY_SOURCE_DIGEST="${ADHDEV_BINDING_SOURCE_DIGEST}"
  ADHDEV_GHOSTTY_GIT_TAG="${GHOSTTY_GIT_TAG}"
  ADHDEV_GHOSTTY_RELEASE_ELIGIBLE=${ADHDEV_GHOSTTY_RELEASE_ELIGIBLE}
  ADHDEV_GHOSTTY_PROVENANCE_PROBLEMS="${ADHDEV_PROVENANCE_PROBLEMS_TEXT}"
  ADHDEV_GHOSTTY_SOURCE_REVISION="${ADHDEV_GHOSTTY_SOURCE_REVISION}"
  ADHDEV_GHOSTTY_SOURCE_CLEAN=${ADHDEV_GHOSTTY_SOURCE_CLEAN}
  ADHDEV_GHOSTTY_ZIG_VERSION="${ADHDEV_ZIG_VERSION}"
  ADHDEV_GHOSTTY_C_COMPILER="${CMAKE_C_COMPILER_ID} ${CMAKE_C_COMPILER_VERSION}"
  ADHDEV_GHOSTTY_CXX_COMPILER="${CMAKE_CXX_COMPILER_ID} ${CMAKE_CXX_COMPILER_VERSION}"
  ADHDEV_GHOSTTY_BUILD_TYPE="${CMAKE_BUILD_TYPE}"
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

cmake_minimum_required(VERSION 3.20)
project(transfer_fs_node LANGUAGES C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

set(ADHDEV_TRANSFER_FS_API_LEVEL 1)

# Binding source digest: LF-normalized SHA-256 over CMakeLists.txt and
# src/transfer_fs_napi.c so prebuilt manifests and runtime checks can verify
# that the loaded binary matches the exact binding sources in the checkout.
set(ADHDEV_BINDING_DIGEST_INPUTS
  CMakeLists.txt
  src/transfer_fs_napi.c
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
message(STATUS "transfer_fs_node binding source digest: ${ADHDEV_BINDING_SOURCE_DIGEST}")

add_library(${PROJECT_NAME} SHARED
  src/transfer_fs_napi.c
)

target_include_directories(${PROJECT_NAME} PRIVATE
  ${CMAKE_JS_INC}
)

target_compile_definitions(${PROJECT_NAME} PRIVATE
  NAPI_VERSION=8
  ADHDEV_TRANSFER_FS_API_LEVEL=${ADHDEV_TRANSFER_FS_API_LEVEL}
  ADHDEV_TRANSFER_FS_SOURCE_DIGEST="${ADHDEV_BINDING_SOURCE_DIGEST}"
  ADHDEV_TRANSFER_FS_C_COMPILER="${CMAKE_C_COMPILER_ID} ${CMAKE_C_COMPILER_VERSION}"
  ADHDEV_TRANSFER_FS_BUILD_TYPE="${CMAKE_BUILD_TYPE}"
)

target_link_libraries(${PROJECT_NAME} PRIVATE
  ${CMAKE_JS_LIB}
)

set_target_properties(${PROJECT_NAME} PROPERTIES
  PREFIX ""
  SUFFIX ".node"
)

if(MSVC)
  # Use dynamic CRT (/MD) to match node.exe and strip embedded PDB/host paths.
  set_target_properties(${PROJECT_NAME} PROPERTIES
    MSVC_RUNTIME_LIBRARY "MultiThreadedDLL"
  )
  target_compile_options(${PROJECT_NAME} PRIVATE /Brepro)
  target_link_options(${PROJECT_NAME} PRIVATE
    /NODEFAULTLIB:LIBCMT
    /NODEFAULTLIB:LIBCMTD
    /INCREMENTAL:NO
    /OPT:REF
    /OPT:ICF
    /PDBALTPATH:%_PDB%
    /Brepro
  )
  target_link_libraries(${PROJECT_NAME} PRIVATE msvcrt vcruntime ucrt)
elseif(APPLE)
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

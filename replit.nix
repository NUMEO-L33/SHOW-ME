{ pkgs }:
let
  showmePkgs = import (builtins.fetchTarball {
    url = "https://github.com/NixOS/nixpkgs/archive/1559d3daa3ecc813a650b79375ea61b6741b8746.tar.gz";
  }) {
    system = pkgs.stdenv.hostPlatform.system;
    config = {};
    overlays = [];
  };
  # Preserve native codecs/filters and the reviewed source. Each JPEG no longer
  # needs GPU/device/subtitle/streaming integrations and their shared libraries.
  # Safety flags are explicit: their upstream defaults depend on headless deps.
  showmeMedia = showmePkgs.ffmpeg_8-headless.override {
    withHeadlessDeps = false;
    withSmallDeps = false;
    withFullDeps = false;
    buildFfmpeg = true;
    buildFfprobe = true;
    buildAvcodec = true;
    buildAvdevice = true; # lavfi synthetic sources, not capture devices
    buildAvfilter = true;
    buildAvformat = true;
    buildAvutil = true;
    buildSwresample = true;
    buildSwscale = true;
    withSafeBitstreamReader = true;
    withHardcodedTables = true;
    withPixelutils = true;
    withRuntimeCPUDetection = true;
    withNetwork = false;
    withX264 = true;
    withX265 = true;
    withVpx = true;
    withAom = true;
    withDav1d = true;
    withOpus = true;
    withZlib = true;
  };
in
assert showmeMedia.version == "8.1.2";
{
  deps = [ showmeMedia ];
}

{ pkgs }:
let
  showmePkgs = import (builtins.fetchTarball {
    url = "https://github.com/NixOS/nixpkgs/archive/1559d3daa3ecc813a650b79375ea61b6741b8746.tar.gz";
  }) {
    system = pkgs.stdenv.hostPlatform.system;
    config = {};
    overlays = [];
  };
in
assert showmePkgs.ffmpeg_8-headless.version == "8.1.2";
{
  # Same reviewed release/pin, without full-only GUI/audio/ML integrations.
  # Image I/O and decoder deadlines are bounded separately in application code.
  deps = [ showmePkgs.ffmpeg_8-headless ];
}

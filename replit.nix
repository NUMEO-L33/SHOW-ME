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
assert showmePkgs.ffmpeg_8-full.version == "8.1.2";
{
  deps = [ showmePkgs.ffmpeg_8-full ];
}

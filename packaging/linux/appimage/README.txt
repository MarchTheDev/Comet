AppImage README

Comet, portable.

Run ./comet. Nothing is installed and nothing is written next to it.

The AppImage is thin on purpose: it carries the binary, the menu entries
and the icon, and asks the host for the libraries it needs.

On Linux, WebKitGTK needs a few GStreamer plugins that WebKit itself does
not pull in. Install them, for example:

  Debian / Ubuntu:   sudo apt install gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-pipewire
  Fedora:            sudo dnf install gstreamer1-plugins-base gstreamer1-plugins-good gstreamer1-plugin-pipewire
  Arch:              sudo pacman -S gst-plugins-base gst-plugins-good gst-plugin-pipewire

Without them the app runs but stays silent.

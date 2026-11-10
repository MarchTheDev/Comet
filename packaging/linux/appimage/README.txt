Comet, portable AppImage
========================

Make the file executable and run it:

    chmod +x Comet-<version>-x86_64.AppImage
    ./Comet-<version>-x86_64.AppImage

Nothing is installed and nothing is written beside the image. Your notes stay in
the workspace folder you choose; settings and organization are kept in Comet's
application profile (~/.local/share/com.marco.comet).

The AppImage is thin on purpose: it carries the binary, the menu entries and the
icon, and asks the host for the libraries it needs. Install WebKitGTK 4.1 and a
Secret Service provider (GNOME Keyring or KWallet) for the password vault.

On Linux, WebKitGTK needs a few GStreamer plugins that WebKit itself does not
pull in. Install them, for example:

  Debian / Ubuntu:   sudo apt install gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-pipewire
  Fedora:            sudo dnf install gstreamer1-plugins-base gstreamer1-plugins-good pipewire-gstreamer
  Arch:              sudo pacman -S gst-plugins-base gst-plugins-good gst-plugin-pipewire

Without them the app runs but stays silent.

On a Wayland session where the window will not draw, use the Comet (X11) menu
entry, or set GDK_BACKEND=x11 before starting the image.

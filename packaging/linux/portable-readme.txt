Comet, portable (Linux)
=======================

Nothing is installed. Run ./comet from this folder. Your notes stay in the
workspace folder you choose; settings and organization are kept in Comet's
application profile (~/.local/share/com.comet), not beside this file.
Removing this folder removes the program, not your files or profile.

On a Wayland session where the window will not draw, run ./comet-x11 instead,
or use the comet-x11.desktop entry. Both are the same program, with
GDK_BACKEND=x11 set before it starts. If the only symptom is a blank window,
try WEBKIT_DISABLE_DMABUF_RENDERER=1 ./comet first: it keeps the native backend.

Comet needs WebKitGTK 4.1 and a Secret Service provider (GNOME Keyring or
KWallet) for the password vault. The packaged builds declare these; a tarball
cannot, so install them with the package manager of your distribution if they
are missing.

If there is no sound
--------------------

Markdown pages can play audio and video, and WebKit plays them through
GStreamer. WebKit needs elements such as autoaudiosink, which are not part of
WebKit itself and are not installed by it. Without them Comet runs fine and is
simply silent.

    Arch            pacman -S gst-plugins-base gst-plugins-good gst-plugin-pipewire
    Debian/Ubuntu   apt install gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-pipewire
    Fedora          dnf install gstreamer1-plugins-base gstreamer1-plugins-good pipewire-gstreamer

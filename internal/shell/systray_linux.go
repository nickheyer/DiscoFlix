//go:build linux && !headless

package shell

import "fyne.io/systray"

// Fails when the session bus refuses a connection, which fyne systray would only log
func trayPreflight() error {
	conn, err := privateSessionBus()
	if err != nil {
		return err
	}
	return conn.Close()
}

// StatusNotifierItem pixmaps are decoded from PNG directly
func trayIcon(png []byte) ([]byte, error) {
	return png, nil
}

// The Linux tray loop waits on a channel, so no thread id is needed
func loopThread() uint32 {
	return 0
}

// Closes the fyne quit channel, which ends the Linux loop whether or not the item registered
func endTrayLoop(uint32) {
	systray.Quit()
}

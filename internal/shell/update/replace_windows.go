package update

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"golang.org/x/sys/windows"
)

// Renames the running binary aside and the synced new one into place with rollback, as Windows forbids overwriting it
func replaceExecutable(path string, bin io.Reader) error {
	dir, base := filepath.Split(path)
	stale, _ := filepath.Glob(filepath.Join(dir, "."+base+".old-*"))
	for _, s := range stale {
		os.Remove(s)
	}
	tmp, err := os.CreateTemp(dir, "."+base+".new-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := io.Copy(tmp, bin); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	old := filepath.Join(dir, "."+base+".old-"+strconv.FormatInt(time.Now().UnixNano(), 36))
	if err := os.Rename(path, old); err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		if rerr := os.Rename(old, path); rerr != nil {
			return fmt.Errorf("update: installing the new binary failed and restoring the old one failed too: %w", errors.Join(err, rerr))
		}
		return err
	}
	if p, err := windows.UTF16PtrFromString(old); err == nil {
		windows.SetFileAttributes(p, windows.FILE_ATTRIBUTE_HIDDEN)
	}
	return nil
}

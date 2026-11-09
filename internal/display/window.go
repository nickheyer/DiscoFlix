package display

import (
	"context"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Run opens the window on o.URL and blocks until the user closes it or ctx ends, calling OnQuit once first
func Run(ctx context.Context, o Options) error {
	if err := Available(); err != nil {
		return err
	}
	var quit sync.Once
	app := application.New(application.Options{
		Name:                        o.Title,
		Icon:                        o.Icon,
		Logger:                      o.Logger,
		DisableDefaultSignalHandler: true,
		ShouldQuit: func() bool {
			quit.Do(o.OnQuit)
			return true
		},
		ErrorHandler: func(err error) { o.Logger.Error("desktop window", "error", err) },
		Mac:          application.MacOptions{ApplicationShouldTerminateAfterLastWindowClosed: true},
		Linux:        application.LinuxOptions{ApplicationID: "io.github.nickheyer.DiscoFlix"},
	})
	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:      "main",
		Title:     o.Title,
		Width:     1280,
		Height:    800,
		MinWidth:  360,
		MinHeight: 480,
		URL:       o.URL,
	})
	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			app.Quit()
		case <-done:
		}
	}()
	err := app.Run()
	close(done)
	return err
}

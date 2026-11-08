package svc

import (
	"os"
	"path/filepath"

	"github.com/kardianos/service"
)

// Job that starts at load and restarts only after a failing exit
const launchdPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>{{Name | html}}</string>
	<key>ProgramArguments</key>
	<array>
		<string>{{Path | html}}</string>
{{range Arguments}}		<string>{{. | html}}</string>
{{end}}	</array>
	<key>WorkingDirectory</key>
	<string>{{WorkingDirectory | html}}</string>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>ThrottleInterval</key>
	<integer>5</integer>
	<key>StandardOutPath</key>
	<string>{{StandardOutPath | html}}</string>
	<key>StandardErrorPath</key>
	<string>{{StandardErrorPath | html}}</string>
</dict>
</plist>
`

// Builds a LaunchAgent for per-user installs or a LaunchDaemon for system installs with logs under the data dir
func newManager(cfg Config) (manager, error) {
	data, _, err := resolve(cfg)
	if err != nil {
		return nil, err
	}
	logs := filepath.Join(data, "logs")
	opts := service.KeyValue{
		"UserService":   cfg.User,
		"LaunchdConfig": launchdPlist,
		"LogDirectory":  logs,
	}
	return newKardianos(cfg, opts, nil, func() error { return os.MkdirAll(logs, 0o750) })
}

// Reports whether launchd started the process as the discoflix job, which sets XPC_SERVICE_NAME to the label
func startedByManager() bool {
	return os.Getenv("XPC_SERVICE_NAME") == Name
}

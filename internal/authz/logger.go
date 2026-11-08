package authz

import (
	"context"
	"log/slog"

	"github.com/openfga/openfga/pkg/logger"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

// slogLogger adapts the OpenFGA zap-shaped logger interface onto slog
type slogLogger struct{ l *slog.Logger }

var _ logger.Logger = slogLogger{}

func (s slogLogger) Level() zapcore.Level {
	ctx := context.Background()
	switch {
	case s.l.Enabled(ctx, slog.LevelDebug):
		return zapcore.DebugLevel
	case s.l.Enabled(ctx, slog.LevelInfo):
		return zapcore.InfoLevel
	case s.l.Enabled(ctx, slog.LevelWarn):
		return zapcore.WarnLevel
	}
	return zapcore.ErrorLevel
}

func attrs(fields []zap.Field) []any {
	enc := zapcore.NewMapObjectEncoder()
	for _, f := range fields {
		f.AddTo(enc)
	}
	out := make([]any, 0, len(enc.Fields)*2)
	for k, v := range enc.Fields {
		out = append(out, k, v)
	}
	return out
}

func (s slogLogger) Debug(m string, f ...zap.Field) { s.l.Debug(m, attrs(f)...) }
func (s slogLogger) Info(m string, f ...zap.Field)  { s.l.Info(m, attrs(f)...) }
func (s slogLogger) Warn(m string, f ...zap.Field)  { s.l.Warn(m, attrs(f)...) }
func (s slogLogger) Error(m string, f ...zap.Field) { s.l.Error(m, attrs(f)...) }
func (s slogLogger) Panic(m string, f ...zap.Field) { s.l.Error(m, attrs(f)...); panic(m) }
func (s slogLogger) Fatal(m string, f ...zap.Field) { s.l.Error(m, attrs(f)...); panic(m) }
func (s slogLogger) With(f ...zap.Field) logger.Logger {
	return slogLogger{s.l.With(attrs(f)...)}
}

func (s slogLogger) DebugWithContext(ctx context.Context, m string, f ...zap.Field) {
	s.l.DebugContext(ctx, m, attrs(f)...)
}

func (s slogLogger) InfoWithContext(ctx context.Context, m string, f ...zap.Field) {
	s.l.InfoContext(ctx, m, attrs(f)...)
}

func (s slogLogger) WarnWithContext(ctx context.Context, m string, f ...zap.Field) {
	s.l.WarnContext(ctx, m, attrs(f)...)
}

func (s slogLogger) ErrorWithContext(ctx context.Context, m string, f ...zap.Field) {
	s.l.ErrorContext(ctx, m, attrs(f)...)
}

func (s slogLogger) PanicWithContext(ctx context.Context, m string, f ...zap.Field) {
	s.l.ErrorContext(ctx, m, attrs(f)...)
	panic(m)
}

func (s slogLogger) FatalWithContext(ctx context.Context, m string, f ...zap.Field) {
	s.l.ErrorContext(ctx, m, attrs(f)...)
	panic(m)
}

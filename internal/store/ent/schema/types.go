package schema

// Attachment is one file carried by a Message, stored as JSON on the row
type Attachment struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	URL         string `json:"url"`
	ContentType string `json:"content_type,omitempty"`
	Size        int64  `json:"size,omitempty"`
	Width       int32  `json:"width,omitempty"`
	Height      int32  `json:"height,omitempty"`
}

// Role is one guild role mirrored for display, stored as JSON on the Space
type Role struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Color    string `json:"color,omitempty"`
	Position int32  `json:"position"`
	Hoist    bool   `json:"hoist,omitempty"`
}

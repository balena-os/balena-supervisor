package updatestatus

type UpdateStatus struct {
	UpdatePending    bool
	UpdateFailed     bool
	UpdateDownloaded bool
	FailCount        int
}

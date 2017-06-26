FILESEXTRAPATHS_append := ":${THISDIR}/${PN}"
SRC_URI_append = " \
    file://rsync-3.1.2-max-128-basis-dirs.patch \
    file://0001-batch-exit-if-we-reach-EOF-during-processing.patch \
    "

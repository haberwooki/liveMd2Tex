# print-var.mk: prints one variable of a generated Makefile, as "make -f Makefile -f print-var.mk print-NAME".
# Ours (the liveMd2Tex authors), GPL-3.0-or-later. Used by build.sh to read automake's lists of a program's objects
# and dependencies instead of copying them by hand.
print-%:
	@:$(info $($*))

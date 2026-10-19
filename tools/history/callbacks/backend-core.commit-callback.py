import re
msg = commit.message
msg = re.sub(rb"(?<![\w/&#:.-])#(\d{1,5})(?!\w)", rb"Kemetra/Backend-Core#\1", msg)
body = msg.rstrip(b"\n")
paras = body.split(b"\n\n")
is_trailers = len(paras) > 1 and all(re.match(rb"^[A-Za-z][A-Za-z0-9-]*: ", l) for l in paras[-1].split(b"\n"))
commit.message = body + (b"\n" if is_trailers else b"\n\n") + b"Original-Commit: " + commit.original_id + b"\n"

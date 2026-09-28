SHELL := /bin/bash
DIST := dist
APP  := $(DIST)/Keyway.app

.PHONY: build install uninstall run clean

build:
	./make-dist.sh

install: build
	node "$(APP)/Contents/Resources/setup.mjs" install \
		--key "$$(cat $${API_KEY_FILE:-$$HOME/.keyway-key})" \
		--provider-name "$${PROVIDER:-OpenAI}" \
		--upstream "$${UPSTREAM:-https://api.openai.com/v1}" \
		--api auto \
		--models "$${MODELS:-gpt-4o-mini}"

uninstall:
	node "$(APP)/Contents/Resources/setup.mjs" uninstall

run:
	node gateway.mjs

clean:
	rm -rf $(DIST)

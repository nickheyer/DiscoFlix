.PHONY: dev start inspect test migrate reset clean

dev:
	node --watch src/server/server.js

start:
	npm run start

inspect:
	npm run inspect

test:
	npm run test

migrate:
	npm run migrate

reset:
	npm run reset

clean:
	rm -rf .cache logs prisma/disco.db*

package authz

// Model is the relationship schema every capability check runs against
const Model = `model
  schema 1.1

type user

type system
  relations
    define admin: [user]
    define member: [user]
    define users_admin: admin
    define discord_admin: admin
    define capabilities_read: member or admin
    define timeline_read: member or admin
    define session_self: member or admin
    define credentials_self: member or admin
    define identity_link: member or admin
    define catalog_read: member or admin
    define catalog_edit: admin
    define catalog_admin: admin

type space
  relations
    define system: [system]
    define admin: [user] or admin from system
    define member: [user] or admin
    define reader: member
    define writer: member

type channel
  relations
    define space: [space]
    define admin: admin from space
    define open: [user:*]
    define viewer: [user]
    define post: [user:*]
    define poster: [user]
    define reader: admin or viewer or (open and member from space)
    define writer: admin or poster or (post and reader)
`

// SystemObject is the single system-level authorization object
const SystemObject = "system:main"

// Everyone is the wildcard subject that opens a channel to every member of its space
const Everyone = "user:*"

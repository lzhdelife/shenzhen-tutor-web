UPDATE publisher_access
SET status = 'approved',
    reviewed_at = COALESCE(reviewed_at, updated_at, requested_at),
    updated_at = COALESCE(updated_at, requested_at)
WHERE status <> 'approved';

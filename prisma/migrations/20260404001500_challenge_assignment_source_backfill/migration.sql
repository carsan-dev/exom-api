WITH visible_creator_scope AS (
  SELECT
    c.id AS challenge_id,
    aca.client_id
  FROM challenges c
  JOIN users creator
    ON creator.id = c.created_by
  JOIN admin_client_assignments aca
    ON aca.admin_id = creator.id
   AND aca.is_active = TRUE
  WHERE c.is_global = TRUE
    AND creator.role = 'ADMIN'

  UNION

  SELECT
    c.id AS challenge_id,
    client.id AS client_id
  FROM challenges c
  JOIN users creator
    ON creator.id = c.created_by
  JOIN users client
    ON client.role = 'CLIENT'
  WHERE c.is_global = TRUE
    AND creator.role = 'SUPER_ADMIN'
)
UPDATE challenge_clients cc
SET assignment_source = 'GLOBAL'
FROM visible_creator_scope vcs
WHERE cc.challenge_id = vcs.challenge_id
  AND cc.client_id = vcs.client_id
  AND cc.assignment_source = 'MANUAL';

CREATE FUNCTION
    variants_insert(
        IN variant_seed text,
        IN params jsonb,
        IN true_answer jsonb,
        IN options jsonb,
        IN broken boolean,
        IN instance_question_id bigint, -- can be NULL
        IN question_id bigint,          -- can be NULL, but needed if instance_question_id is NULL
        IN course_instance_id bigint,   -- can be NULL for some instructor questions
        IN user_id bigint,              -- can be NULL, but needed if instance_question_id is NULL
        IN authn_user_id bigint,
        IN group_work boolean,
        IN require_open boolean,
        IN variant_course_id bigint,
        OUT variant json
    )
AS $$
DECLARE
    real_question_id bigint;
    real_course_instance_id bigint;
    real_user_id bigint;
    real_group_id bigint;
    new_number integer;
    assessment_instance_id bigint;
    variant_id bigint;
    question_workspace_image text;
    workspace_id bigint;
    existing_variant json;
BEGIN
    -- The caller must have provided either instance_question_id or
    -- the (question_id, user_id). If instance_question_id is not
    -- NULL, then we use it to look up the other two. Otherwise we
    -- just use them. Similarly for course_instance_id.

    IF instance_question_id IS NOT NULL THEN
        PERFORM instance_questions_lock(instance_question_id);

        SELECT           q.id,          g.id,    u.user_id,                  ai.id,                   ci.id
        INTO real_question_id, real_group_id, real_user_id, assessment_instance_id, real_course_instance_id
        FROM
            instance_questions AS iq
            JOIN assessment_questions AS aq ON (aq.id = iq.assessment_question_id)
            JOIN questions AS q ON (q.id = aq.question_id)
            JOIN assessment_instances AS ai ON (ai.id = iq.assessment_instance_id)
            JOIN assessments AS a ON (a.id = ai.assessment_id)
            JOIN course_instances AS ci ON (ci.id = a.course_instance_id)
            LEFT OUTER JOIN groups AS g ON (g.id = ai.group_id AND g.deleted_at IS NULL)
            LEFT OUTER JOIN users AS u ON (u.user_id = ai.user_id)
        WHERE
            iq.id = instance_question_id;

        IF NOT FOUND THEN RAISE EXCEPTION 'instance_question not found'; END IF;

        -- This handles the race condition where we simultaneously start generating
        -- two variants for the same instance question. If we're the second one
        -- to try and insert a variant, just pull the existing variant back out of
        -- the database and use that instead.
        existing_variant := instance_questions_select_variant(instance_question_id, require_open);
        IF existing_variant IS NOT NULL THEN
            SELECT variants_select((existing_variant->>'id')::bigint, real_question_id, instance_question_id)
            INTO variant;
            RETURN;
        END IF;

        PERFORM instance_questions_ensure_open(instance_question_id);
        PERFORM assessment_instances_ensure_open(assessment_instance_id);

        SELECT max(v.number)
        INTO new_number
        FROM variants AS v
        WHERE v.instance_question_id = variants_insert.instance_question_id;

        new_number := coalesce(new_number + 1, 1);
    ELSE
        -- we weren't given an instance_question_id, so we must have
        -- question_id and user_id
        IF question_id IS NULL THEN RAISE EXCEPTION 'no instance_question_id and no question_id'; END IF;
        IF user_id IS NULL THEN RAISE EXCEPTION 'no instance_question_id and no user_id'; END IF;

        real_question_id := question_id;
        real_course_instance_id := course_instance_id;
        real_user_id := user_id;
    END IF;

    -- check consistency of question_id and course_id
    SELECT q.id
    INTO real_question_id
    FROM
        questions AS q
    WHERE
        q.id = real_question_id
        -- TODO: when implementing question sharing, make sure the question has been shared with the course_id
        -- instead of requiring the question being created in the course that created it.
        AND q.course_id = variant_course_id;
    IF real_question_id IS NULL THEN RAISE EXCEPTION 'inconsistent course for question_id and course_id'; END IF;

    -- check consistency of course_instance_id and course_id
    IF real_course_instance_id IS NOT NULL THEN
        PERFORM *
        FROM
            course_instances AS ci
            JOIN pl_courses AS c ON ci.course_id = c.id
        WHERE
            ci.id = real_course_instance_id
            AND ci.course_id = variant_course_id;

        IF NOT FOUND THEN RAISE EXCEPTION 'inconsistent course_instance_id for course_id'; END IF;
    END IF;

    -- check if workspace needed
    SELECT q.workspace_image
    INTO question_workspace_image
    FROM questions as q
    WHERE q.id = real_question_id;

    -- create workspace if needed
    IF question_workspace_image IS NOT NULL THEN
        INSERT INTO workspaces
        DEFAULT VALUES
        RETURNING id
        INTO workspace_id;
    END IF;

    INSERT INTO variants
        (instance_question_id, question_id,      course_instance_id, user_id, group_id,
        number,     variant_seed, params, true_answer, options, broken, authn_user_id,
        workspace_id, course_id)
    VALUES
        (instance_question_id, real_question_id, real_course_instance_id, real_user_id, real_group_id,
        new_number, variant_seed, params, true_answer, options, broken, authn_user_id,
        workspace_id, variant_course_id)
    RETURNING id
    INTO variant_id;

    SELECT variants_select(variant_id, real_question_id, instance_question_id)
    INTO variant;
END;
$$ LANGUAGE plpgsql VOLATILE;
